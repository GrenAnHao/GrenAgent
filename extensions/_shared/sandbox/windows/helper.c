/*
 * pi-sandbox-win — write-restricted token helper.
 *
 * Usage:
 *   pi-sandbox-win.exe [--workspace-sid SID] [--temp-sid SID] -- command [args...]
 *
 * workspace-write passes both capability SIDs. read-only omits them; the
 * restricting SID set is then logon SID + Everyone only.
 *
 * Exit:
 *   162  child ended with a write / access denial
 *   163  helper API or argv failure (stderr: "pi-sandbox-win: <Api> failed")
 *   else child's exit code
 *
 * Build later (task 13), do not check in the exe:
 *   cl /O2 /Fe:bin\pi-sandbox-win.exe helper.c advapi32.lib shell32.lib
 *   gcc -O2 -o bin/pi-sandbox-win.exe helper.c -ladvapi32 -lshell32
 */

#define WIN32_LEAN_AND_MEAN
#define UNICODE
#define _UNICODE
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0601
#endif

#include <windows.h>
#include <sddl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "shell32.lib")

#ifndef DISABLE_MAX_PRIVILEGE
#define DISABLE_MAX_PRIVILEGE 0x1
#endif
#ifndef LUA_TOKEN
#define LUA_TOKEN 0x4
#endif
#ifndef WRITE_RESTRICTED
#define WRITE_RESTRICTED 0x8
#endif

#ifndef SECURITY_MAX_SID_SIZE
#define SECURITY_MAX_SID_SIZE 68
#endif

#define DENIAL_EXIT 162
#define HELPER_FAIL_EXIT 163
#define MAX_RESTRICTING_SIDS 4
#define NTSTATUS_ACCESS_DENIED 0xC0000022u

static void fail(const char *api) {
    fprintf(stderr, "pi-sandbox-win: %s failed\n", api);
    ExitProcess(HELPER_FAIL_EXIT);
}

static void enablePrivilege(HANDLE token, LPCWSTR name) {
    TOKEN_PRIVILEGES tp;
    ZeroMemory(&tp, sizeof(tp));
    if (!LookupPrivilegeValueW(NULL, name, &tp.Privileges[0].Luid)) {
        return;
    }
    tp.PrivilegeCount = 1;
    tp.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
    AdjustTokenPrivileges(token, FALSE, &tp, 0, NULL, NULL);
}

static PSID copySid(PSID src) {
    DWORD n;
    PSID dst;

    if (!IsValidSid(src)) {
        fail("IsValidSid");
    }
    n = GetLengthSid(src);
    dst = (PSID)LocalAlloc(LMEM_FIXED, n);
    if (!dst) {
        fail("LocalAlloc");
    }
    if (!CopySid(n, dst, src)) {
        LocalFree(dst);
        fail("CopySid");
    }
    return dst;
}

static PSID sidFromString(LPCWSTR text, const char *api) {
    PSID sid = NULL;
    if (!ConvertStringSidToSidW(text, &sid) || !sid) {
        fail(api);
    }
    return sid;
}

static PSID logonSidFromToken(HANDLE token) {
    DWORD needed = 0;
    PTOKEN_GROUPS groups;
    DWORD i;
    PSID found = NULL;

    GetTokenInformation(token, TokenGroups, NULL, 0, &needed);
    if (needed == 0) {
        fail("GetTokenInformation");
    }
    groups = (PTOKEN_GROUPS)LocalAlloc(LMEM_FIXED | LMEM_ZEROINIT, needed);
    if (!groups) {
        fail("LocalAlloc");
    }
    if (!GetTokenInformation(token, TokenGroups, groups, needed, &needed)) {
        LocalFree(groups);
        fail("GetTokenInformation");
    }
    for (i = 0; i < groups->GroupCount; i++) {
        if (groups->Groups[i].Attributes & SE_GROUP_LOGON_ID) {
            found = copySid(groups->Groups[i].Sid);
            break;
        }
    }
    LocalFree(groups);
    if (!found) {
        fail("TokenLogonSid");
    }
    return found;
}

static size_t quoteArg(const wchar_t *arg, wchar_t *out, size_t cap) {
    const wchar_t *p;
    size_t used = 0;
    int slashes;
    BOOL quote = (*arg == L'\0');

    for (p = arg; *p; p++) {
        if (*p == L' ' || *p == L'\t' || *p == L'\n' || *p == L'\v' || *p == L'"') {
            quote = TRUE;
            break;
        }
    }

#define PUT(ch) do { if (used + 1 >= cap) fail("HeapAlloc"); out[used++] = (ch); } while (0)

    if (!quote) {
        for (p = arg; *p; p++) {
            PUT(*p);
        }
        out[used] = L'\0';
        return used;
    }

    PUT(L'"');
    for (;;) {
        slashes = 0;
        while (*arg == L'\\') {
            PUT(L'\\');
            arg++;
            slashes++;
        }
        if (*arg == L'\0') {
            while (slashes-- > 0) {
                PUT(L'\\');
            }
            break;
        }
        if (*arg == L'"') {
            while (slashes-- > 0) {
                PUT(L'\\');
            }
            PUT(L'\\');
        }
        PUT(*arg);
        arg++;
    }
    PUT(L'"');
    out[used] = L'\0';
    return used;

#undef PUT
}

static wchar_t *buildCommandLine(int argc, wchar_t **argv) {
    size_t cap = 8;
    wchar_t *buf;
    size_t used = 0;
    int i;

    for (i = 0; i < argc; i++) {
        cap += wcslen(argv[i]) * 2 + 8;
    }
    buf = (wchar_t *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, cap * sizeof(wchar_t));
    if (!buf) {
        fail("HeapAlloc");
    }
    for (i = 0; i < argc; i++) {
        if (i) {
            if (used + 2 >= cap) {
                fail("HeapAlloc");
            }
            buf[used++] = L' ';
        }
        used += quoteArg(argv[i], buf + used, cap - used);
    }
    return buf;
}

static void inheritStdHandle(DWORD which, HANDLE *out) {
    HANDLE h = GetStdHandle(which);
    *out = h;
    if (h && h != INVALID_HANDLE_VALUE) {
        SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
    }
}

static int run(int argc, wchar_t **argv) {
    LPCWSTR workspaceSid = NULL;
    LPCWSTR tempSid = NULL;
    int commandIndex = -1;
    int i;
    HANDLE processToken = NULL;
    HANDLE restricted = NULL;
    HANDLE primary = NULL;
    PSID restrictingSids[MAX_RESTRICTING_SIDS];
    SID_AND_ATTRIBUTES sidAttrs[MAX_RESTRICTING_SIDS];
    DWORD sidCount = 0;
    DWORD flags;
    wchar_t *commandLine;
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    DWORD wait;
    DWORD exitCode;

    ZeroMemory(restrictingSids, sizeof(restrictingSids));
    ZeroMemory(sidAttrs, sizeof(sidAttrs));

    for (i = 1; i < argc; i++) {
        if (wcscmp(argv[i], L"--") == 0) {
            commandIndex = i + 1;
            break;
        }
        if (wcscmp(argv[i], L"--workspace-sid") == 0) {
            if (i + 1 >= argc) {
                fail("argv");
            }
            workspaceSid = argv[++i];
            continue;
        }
        if (wcscmp(argv[i], L"--temp-sid") == 0) {
            if (i + 1 >= argc) {
                fail("argv");
            }
            tempSid = argv[++i];
            continue;
        }
        fail("argv");
    }

    if (commandIndex < 0 || commandIndex >= argc) {
        fail("argv");
    }

    if (!OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_PRIVILEGES,
            &processToken)) {
        fail("OpenProcessToken");
    }

    enablePrivilege(processToken, SE_INCREASE_QUOTA_NAME);
    enablePrivilege(processToken, SE_ASSIGNPRIMARYTOKEN_NAME);

    restrictingSids[sidCount++] = logonSidFromToken(processToken);
    restrictingSids[sidCount++] = sidFromString(L"S-1-1-0", "ConvertStringSidToSid");
    if (workspaceSid) {
        restrictingSids[sidCount++] = sidFromString(workspaceSid, "ConvertStringSidToSid");
    }
    if (tempSid) {
        restrictingSids[sidCount++] = sidFromString(tempSid, "ConvertStringSidToSid");
    }

    for (i = 0; i < (int)sidCount; i++) {
        sidAttrs[i].Sid = restrictingSids[i];
        sidAttrs[i].Attributes = 0;
    }

    flags = WRITE_RESTRICTED | DISABLE_MAX_PRIVILEGE | LUA_TOKEN;
    if (!CreateRestrictedToken(
            processToken,
            flags,
            0,
            NULL,
            0,
            NULL,
            sidCount,
            sidAttrs,
            &restricted)) {
        fail("CreateRestrictedToken");
    }

    if (!DuplicateTokenEx(
            restricted,
            TOKEN_ASSIGN_PRIMARY | TOKEN_DUPLICATE | TOKEN_QUERY |
                TOKEN_ADJUST_DEFAULT | TOKEN_ADJUST_SESSIONID,
            NULL,
            SecurityImpersonation,
            TokenPrimary,
            &primary)) {
        fail("DuplicateTokenEx");
    }

    commandLine = buildCommandLine(argc - commandIndex, argv + commandIndex);

    ZeroMemory(&si, sizeof(si));
    ZeroMemory(&pi, sizeof(pi));
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    inheritStdHandle(STD_INPUT_HANDLE, &si.hStdInput);
    inheritStdHandle(STD_OUTPUT_HANDLE, &si.hStdOutput);
    inheritStdHandle(STD_ERROR_HANDLE, &si.hStdError);

    if (!CreateProcessAsUserW(
            primary,
            NULL,
            commandLine,
            NULL,
            NULL,
            TRUE,
            0,
            NULL,
            NULL,
            &si,
            &pi)) {
        fail("CreateProcessAsUserW");
    }

    HeapFree(GetProcessHeap(), 0, commandLine);
    CloseHandle(pi.hThread);

    wait = WaitForSingleObject(pi.hProcess, INFINITE);
    if (wait != WAIT_OBJECT_0) {
        fail("WaitForSingleObject");
    }
    if (!GetExitCodeProcess(pi.hProcess, &exitCode)) {
        fail("GetExitCodeProcess");
    }

    CloseHandle(pi.hProcess);
    CloseHandle(primary);
    CloseHandle(restricted);
    CloseHandle(processToken);
    for (i = 0; i < (int)sidCount; i++) {
        LocalFree(restrictingSids[i]);
    }

    if (exitCode == ERROR_ACCESS_DENIED || exitCode == NTSTATUS_ACCESS_DENIED) {
        return DENIAL_EXIT;
    }
    return (int)exitCode;
}

int main(void) {
    int argc = 0;
    int rc;
    LPWSTR *wargv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (!wargv) {
        fail("CommandLineToArgvW");
    }
    rc = run(argc, wargv);
    LocalFree(wargv);
    return rc;
}
