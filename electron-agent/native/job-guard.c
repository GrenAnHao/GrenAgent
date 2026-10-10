/*
 * pi-job-guard.exe --pid <agent-host pid> [--wait-ms <ms>]
 *
 * 主进程每拉起一个 agent-host 子进程就启动一个本程序（detached，主进程崩溃也活着）。
 * 它把 agent-host 放进一个 Job：允许显式 CREATE_BREAKAWAY_FROM_JOB，不允许静默脱离。
 * agent-host 之后拉起的子孙进程（MCP 服务器、bash、子代理、它们再拉起的进程）都在这个 Job 里。
 * libuv 自己给子进程建的 Job 带 SILENT_BREAKAWAY_OK，孙进程会脱离；脱离会沿 Job 链往上走，
 * 停在第一个不允许脱离的 Job，也就是这里。
 *
 * stdin 关闭（主进程关掉管道，或主进程退出）之后：
 *   1. 等 agent-host 退出，最多 --wait-ms（默认 15000）毫秒，超时就终止它；
 *   2. 结束 Job 里还活着的进程。有可见顶层窗口的进程，以及它在 Job 里的子孙，保留：
 *      agent 命令打开的编辑器、浏览器、终端是用户在用的窗口。
 *
 * 不设 KILL_ON_JOB_CLOSE：本程序自己被杀或崩溃时什么都不结束，正在跑的 agent-host 不受影响。
 *
 * stdout：分配成功 "ready"；失败 "error <step> <win32 error>"，退出码 2；清理后 "swept <n> kept <m>"。
 *
 * 在 VS 的 x64 Native Tools 命令行里（electron-agent/native 目录）：
 *   cl /nologo /O2 /W4 /utf-8 /DUNICODE /D_UNICODE job-guard.c /Fe:bin\pi-job-guard.exe /link user32.lib
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

#define EXIT_SETUP_FAILED 2
#define DEFAULT_WAIT_MS 15000
#define MAX_PARENT_DEPTH 64
#define SWEEP_ROUNDS 3

typedef struct {
    DWORD *items;
    size_t count;
    size_t capacity;
} PidList;

typedef struct {
    DWORD pid;
    DWORD parent;
} ProcessEntry;

static void out(const char *format, ...) {
    va_list args;
    va_start(args, format);
    vfprintf(stdout, format, args);
    va_end(args);
    fputc('\n', stdout);
    fflush(stdout);
}

static int pid_list_push(PidList *list, DWORD pid) {
    if (list->count == list->capacity) {
        size_t next = list->capacity ? list->capacity * 2 : 64;
        DWORD *grown = (DWORD *)realloc(list->items, next * sizeof(DWORD));
        if (!grown) return 0;
        list->items = grown;
        list->capacity = next;
    }
    list->items[list->count++] = pid;
    return 1;
}

static int pid_list_has(const PidList *list, DWORD pid) {
    size_t i;
    for (i = 0; i < list->count; i++) {
        if (list->items[i] == pid) return 1;
    }
    return 0;
}

/*
 * 可见且有面积的顶层窗口。不要求无 owner：WinForms 等框架给不进任务栏的窗口挂一个隐藏的 owner。
 * 面积为 0 的可见窗口是一些程序的辅助窗口，不算用户在用的界面。
 */
static BOOL CALLBACK collect_visible(HWND hwnd, LPARAM param) {
    DWORD pid = 0;
    RECT rect;
    if (!IsWindowVisible(hwnd) || !GetWindowRect(hwnd, &rect)) return TRUE;
    if (rect.right - rect.left <= 0 || rect.bottom - rect.top <= 0) return TRUE;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid && !pid_list_has((PidList *)param, pid)) pid_list_push((PidList *)param, pid);
    return TRUE;
}

/* Job 里当前的进程 id。 */
static int job_pids(HANDLE job, PidList *result) {
    DWORD capacity = 256;
    for (;;) {
        DWORD size = (DWORD)(sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) + capacity * sizeof(ULONG_PTR));
        JOBOBJECT_BASIC_PROCESS_ID_LIST *info = (JOBOBJECT_BASIC_PROCESS_ID_LIST *)malloc(size);
        DWORD i;
        if (!info) return 0;
        if (!QueryInformationJobObject(job, JobObjectBasicProcessIdList, info, size, NULL) && GetLastError() != ERROR_MORE_DATA) {
            free(info);
            return 0;
        }
        if (info->NumberOfAssignedProcesses > info->NumberOfProcessIdsInList) {
            capacity = info->NumberOfAssignedProcesses + 64;
            free(info);
            continue;
        }
        for (i = 0; i < info->NumberOfProcessIdsInList; i++) pid_list_push(result, (DWORD)info->ProcessIdList[i]);
        free(info);
        return 1;
    }
}

static ProcessEntry *snapshot_processes(size_t *count) {
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    PROCESSENTRY32W entry;
    ProcessEntry *items = NULL;
    size_t used = 0, capacity = 0;
    *count = 0;
    if (snap == INVALID_HANDLE_VALUE) return NULL;
    entry.dwSize = sizeof(entry);
    if (Process32FirstW(snap, &entry)) {
        do {
            if (used == capacity) {
                size_t next = capacity ? capacity * 2 : 512;
                ProcessEntry *grown = (ProcessEntry *)realloc(items, next * sizeof(ProcessEntry));
                if (!grown) break;
                items = grown;
                capacity = next;
            }
            items[used].pid = entry.th32ProcessID;
            items[used].parent = entry.th32ParentProcessID;
            used++;
        } while (Process32NextW(snap, &entry));
    }
    CloseHandle(snap);
    *count = used;
    return items;
}

static DWORD parent_of(const ProcessEntry *items, size_t count, DWORD pid) {
    size_t i;
    for (i = 0; i < count; i++) {
        if (items[i].pid == pid) return items[i].parent;
    }
    return 0;
}

/* 自己有可见窗口，或者 Job 内的某个祖先有可见窗口。只沿 Job 内的进程往上找：Job 外的祖先（以及被复用的 pid）不算。 */
static int is_protected(DWORD pid, const PidList *members, const PidList *visible, const ProcessEntry *items, size_t count) {
    int depth;
    DWORD current = pid;
    for (depth = 0; depth < MAX_PARENT_DEPTH && current; depth++) {
        if (pid_list_has(visible, current)) return 1;
        current = parent_of(items, count, current);
        if (!pid_list_has(members, current)) return 0;
    }
    return 0;
}

static void sweep(HANDLE job, DWORD self) {
    int round;
    unsigned swept = 0, kept = 0;
    for (round = 0; round < SWEEP_ROUNDS; round++) {
        PidList members = { 0 }, visible = { 0 };
        size_t count = 0, i;
        ProcessEntry *items;
        unsigned killed_this_round = 0;
        if (!job_pids(job, &members) || members.count == 0) {
            free(members.items);
            break;
        }
        EnumWindows(collect_visible, (LPARAM)&visible);
        items = snapshot_processes(&count);
        kept = 0;
        for (i = 0; i < members.count; i++) {
            DWORD pid = members.items[i];
            HANDLE process;
            if (pid == self) continue;
            if (is_protected(pid, &members, &visible, items, count)) {
                kept++;
                continue;
            }
            process = OpenProcess(PROCESS_TERMINATE, FALSE, pid);
            if (!process) continue;
            if (TerminateProcess(process, 1)) {
                swept++;
                killed_this_round++;
            }
            CloseHandle(process);
        }
        free(items);
        free(members.items);
        free(visible.items);
        if (killed_this_round == 0) break;
        Sleep(100);
    }
    out("swept %u kept %u", swept, kept);
}

static void wait_stdin_closed(void) {
    HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    char buffer[256];
    DWORD read = 0;
    if (!input || input == INVALID_HANDLE_VALUE) return;
    while (ReadFile(input, buffer, sizeof(buffer), &read, NULL) && read > 0) {
        /* 内容不用：管道关闭就是信号 */
    }
}

int wmain(int argc, wchar_t **argv) {
    DWORD pid = 0, wait_ms = DEFAULT_WAIT_MS;
    HANDLE job, process;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
    int i;

    for (i = 1; i + 1 < argc; i++) {
        if (wcscmp(argv[i], L"--pid") == 0) pid = (DWORD)wcstoul(argv[++i], NULL, 10);
        else if (wcscmp(argv[i], L"--wait-ms") == 0) wait_ms = (DWORD)wcstoul(argv[++i], NULL, 10);
    }
    if (!pid) {
        out("error args 0");
        return EXIT_SETUP_FAILED;
    }

    job = CreateJobObjectW(NULL, NULL);
    if (!job) {
        out("error CreateJobObject %lu", (unsigned long)GetLastError());
        return EXIT_SETUP_FAILED;
    }
    ZeroMemory(&limits, sizeof(limits));
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_BREAKAWAY_OK;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
        out("error SetInformationJobObject %lu", (unsigned long)GetLastError());
        return EXIT_SETUP_FAILED;
    }
    process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE | SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) {
        out("error OpenProcess %lu", (unsigned long)GetLastError());
        return EXIT_SETUP_FAILED;
    }
    if (!AssignProcessToJobObject(job, process)) {
        out("error AssignProcessToJobObject %lu", (unsigned long)GetLastError());
        return EXIT_SETUP_FAILED;
    }
    out("ready");

    wait_stdin_closed();
    if (WaitForSingleObject(process, wait_ms) == WAIT_TIMEOUT) {
        TerminateProcess(process, 1);
        WaitForSingleObject(process, 2000);
    }
    sweep(job, GetCurrentProcessId());
    CloseHandle(process);
    CloseHandle(job);
    return 0;
}
