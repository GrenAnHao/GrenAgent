/*
 * Windows-subsystem stub. CreateProcessWithLogonW cannot take CREATE_NO_WINDOW,
 * so the helper logs on by starting this exe (no console). This process then
 * starts the real command with CREATE_NO_WINDOW and the inherited std handles.
 *
 *   gcc -O2 -mwindows -o bin/pi-sandbox-launch.exe launch.c
 */
#define WIN32_LEAN_AND_MEAN
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <stdio.h>

#define HELPER_FAIL_EXIT 163
#ifndef CREATE_NO_WINDOW
#define CREATE_NO_WINDOW 0x08000000
#endif

static void fail(const char *api) {
    DWORD err = GetLastError();
    HANDLE errh = GetStdHandle(STD_ERROR_HANDLE);
    char buf[160];
    int n = _snprintf(buf, sizeof(buf), "pi-sandbox-win: %s failed %lu\n", api, (unsigned long)err);
    DWORD wrote = 0;
    if (n > 0 && errh && errh != INVALID_HANDLE_VALUE) {
        WriteFile(errh, buf, (DWORD)n, &wrote, NULL);
    }
    ExitProcess(HELPER_FAIL_EXIT);
}

/* A restricted copy of this process's own token with Authenticated Users turned into a deny-only group.
 * A data drive root grants Authenticated Users Modify (Users only get read), and that is how this account
 * could write next to the workspace without any grant. Deny-only means ACEs that allow the group no longer
 * count while ACEs that deny it still do. The account's own SID is untouched, so the explicit grants on the
 * workspace and temp directory keep working. Deriving it from our own token needs no extra privilege.
 * Fail closed: without it the command would run with the wider token. */
static HANDLE restricted_token(void) {
    HANDLE self = NULL;
    HANDLE restricted = NULL;
    PSID authenticatedUsers = NULL;
    SID_IDENTIFIER_AUTHORITY ntAuthority = SECURITY_NT_AUTHORITY;
    SID_AND_ATTRIBUTES disable;

    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY, &self)) {
        fail("OpenProcessToken");
    }
    if (!AllocateAndInitializeSid(&ntAuthority, 1, SECURITY_AUTHENTICATED_USER_RID, 0, 0, 0, 0, 0, 0, 0, &authenticatedUsers)) {
        fail("AllocateAndInitializeSid");
    }
    disable.Sid = authenticatedUsers;
    disable.Attributes = 0;
    if (!CreateRestrictedToken(self, 0, 1, &disable, 0, NULL, 0, NULL, &restricted)) {
        fail("CreateRestrictedToken");
    }
    FreeSid(authenticatedUsers);
    CloseHandle(self);
    return restricted;
}

/* The logged-on profile may not have Local\Temp yet. Create it before the command. */
static void ensure_dir(wchar_t *path) {
    size_t i;
    if (!path || !path[0]) {
        return;
    }
    if (CreateDirectoryW(path, NULL) || GetLastError() == ERROR_ALREADY_EXISTS) {
        return;
    }
    for (i = 0; path[i]; i++) {
        if (path[i] == L'\\' && i > 2) {
            path[i] = L'\0';
            CreateDirectoryW(path, NULL);
            path[i] = L'\\';
        }
    }
    CreateDirectoryW(path, NULL);
}

static void ensure_env_dir(const wchar_t *key) {
    wchar_t buf[MAX_PATH];
    DWORD n = GetEnvironmentVariableW(key, buf, MAX_PATH);
    if (n == 0 || n >= MAX_PATH) {
        return;
    }
    ensure_dir(buf);
}

/* Tail of this process command line, after argv[0]. */
static wchar_t *command_tail(void) {
    wchar_t *line = GetCommandLineW();
    if (*line == L'"') {
        line++;
        while (*line && *line != L'"') {
            if (*line == L'\\' && line[1]) {
                line++;
            }
            line++;
        }
        if (*line == L'"') {
            line++;
        }
    } else {
        while (*line && *line != L' ' && *line != L'\t') {
            line++;
        }
    }
    while (*line == L' ' || *line == L'\t') {
        line++;
    }
    if (*line == L'\0') {
        SetLastError(ERROR_INVALID_PARAMETER);
        fail("argv");
    }
    return line;
}

int WINAPI WinMain(HINSTANCE instance, HINSTANCE prev, LPSTR command, int show) {
    wchar_t *tail = command_tail();
    size_t chars = wcslen(tail) + 1;
    wchar_t *commandLine = (wchar_t *)HeapAlloc(GetProcessHeap(), 0, chars * sizeof(wchar_t));
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    HANDLE job;
    HANDLE token;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION jobInfo;
    DWORD wait;
    DWORD exitCode;
    (void)instance;
    (void)prev;
    (void)command;
    (void)show;
    if (!commandLine) {
        fail("HeapAlloc");
    }
    memcpy(commandLine, tail, chars * sizeof(wchar_t));
    ensure_env_dir(L"USERPROFILE");
    ensure_env_dir(L"APPDATA");
    ensure_env_dir(L"LOCALAPPDATA");
    ensure_env_dir(L"TEMP");
    ensure_env_dir(L"TMP");

    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    if (si.hStdInput && si.hStdInput != INVALID_HANDLE_VALUE) {
        SetHandleInformation(si.hStdInput, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
    }
    if (si.hStdOutput && si.hStdOutput != INVALID_HANDLE_VALUE) {
        SetHandleInformation(si.hStdOutput, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
    }
    if (si.hStdError && si.hStdError != INVALID_HANDLE_VALUE) {
        SetHandleInformation(si.hStdError, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
    }

    /* The helper can only put this launcher into its own job after CreateProcessWithLogonW returns, and cannot
     * reach this account's other processes. So the command gets a job of its own, owned by this launcher: when the
     * launcher is killed (job assignment failed, abort, timeout) the last handle closes and the command dies too.
     * The command starts suspended so it never runs outside the job. No breakaway, as in the helper's job. */
    job = CreateJobObjectW(NULL, NULL);
    if (!job) {
        fail("CreateJobObjectW");
    }
    ZeroMemory(&jobInfo, sizeof(jobInfo));
    jobInfo.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &jobInfo, sizeof(jobInfo))) {
        fail("SetInformationJobObject");
    }

    ZeroMemory(&pi, sizeof(pi));
    token = restricted_token();
    if (!CreateProcessAsUserW(
            token,
            NULL,
            commandLine,
            NULL,
            NULL,
            TRUE,
            CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED,
            NULL,
            NULL,
            &si,
            &pi)) {
        fail("CreateProcessAsUserW");
    }
    CloseHandle(token);
    HeapFree(GetProcessHeap(), 0, commandLine);
    if (!AssignProcessToJobObject(job, pi.hProcess)) {
        DWORD err = GetLastError();
        TerminateProcess(pi.hProcess, HELPER_FAIL_EXIT);
        SetLastError(err);
        fail("AssignProcessToJobObject");
    }
    if (ResumeThread(pi.hThread) == (DWORD)-1) {
        TerminateProcess(pi.hProcess, HELPER_FAIL_EXIT);
        fail("ResumeThread");
    }
    CloseHandle(pi.hThread);
    wait = WaitForSingleObject(pi.hProcess, INFINITE);
    if (wait != WAIT_OBJECT_0) {
        fail("WaitForSingleObject");
    }
    if (!GetExitCodeProcess(pi.hProcess, &exitCode)) {
        fail("GetExitCodeProcess");
    }
    CloseHandle(pi.hProcess);
    return (int)exitCode;
}
