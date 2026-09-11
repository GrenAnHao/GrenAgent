/*
 * pi-sandbox-win — write-restricted token helper.
 *
 * Usage:
 *   pi-sandbox-win.exe [--workspace DIR --workspace-sid SID]
 *                      --temp DIR [--temp-sid SID] -- command [args...]
 *
 * workspace-write: both capability SIDs plus directory paths.
 * read-only: --temp only (no workspace path / capability SIDs). Restricting
 * SIDs are then logon SID + Everyone. Do not add capability SIDs to TokenGroups.
 *
 * ACL contract (before CreateProcess):
 *   workspace-write — SetNamedSecurityInfoW on workspace and temp, GRANT
 *     inheritable (OI|CI / SUB_CONTAINERS_AND_OBJECTS_INHERIT) Modify
 *     (GENERIC_READ|GENERIC_WRITE|DELETE) to the matching capability SID.
 *   read-only — stamp temp with Everyone the same way; do not stamp workspace.
 * Without these ACEs, WRITE_RESTRICTED denies writes even inside the workspace.
 *
 * TokenDefaultDacl (SetTokenInformation):
 *   GetTokenInformation(TokenDefaultDacl) then GRANT_ACCESS merge — keep
 *   User/SYSTEM, add capability SIDs (workspace-write) or Everyone (read-only).
 *   Do not rebuild from an empty ACL. Pipes and grandchild objects stay writable.
 *
 * Exit:
 *   162  ONLY when the child exit code is 5 (ERROR_ACCESS_DENIED) or
 *        STATUS_ACCESS_DENIED (0xC0000022). bash write denials usually exit 1;
 *        those are classified via denialSignatures ("access is denied" / 拒绝访问).
 *   163  helper API or argv failure
 *        (stderr: "pi-sandbox-win: <Api> failed <GetLastError decimal>")
 *   else child's exit code
 *
 * Build (do not check in the exe):
 *   cl /O2 /Fe:bin\pi-sandbox-win.exe helper.c advapi32.lib shell32.lib
 *   gcc -O2 -o bin/pi-sandbox-win.exe helper.c -ladvapi32 -lshell32
 */

#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0601
#endif
#ifndef WINVER
#define WINVER 0x0601
#endif

#define WIN32_LEAN_AND_MEAN
#define UNICODE
#define _UNICODE

#include <windows.h>
#include <shellapi.h>
#include <sddl.h>
#include <aclapi.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _MSC_VER
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "shell32.lib")
#endif

#ifndef DISABLE_MAX_PRIVILEGE
#define DISABLE_MAX_PRIVILEGE 0x1
#endif
#ifndef LUA_TOKEN
#define LUA_TOKEN 0x4
#endif
#ifndef WRITE_RESTRICTED
#define WRITE_RESTRICTED 0x8
#endif

#ifndef EXTENDED_STARTUPINFO_PRESENT
#define EXTENDED_STARTUPINFO_PRESENT 0x00080000
#endif

#ifndef PROC_THREAD_ATTRIBUTE_HANDLE_LIST
#define PROC_THREAD_ATTRIBUTE_NUMBER 0x0000FFFF
#define PROC_THREAD_ATTRIBUTE_INPUT 0x00020000
#define PROC_THREAD_ATTRIBUTE_HANDLE_LIST \
    ((2 & PROC_THREAD_ATTRIBUTE_NUMBER) | PROC_THREAD_ATTRIBUTE_INPUT)
#endif

#ifndef SUB_CONTAINERS_AND_OBJECTS_INHERIT
#define SUB_CONTAINERS_AND_OBJECTS_INHERIT 0x3
#endif

#define DENIAL_EXIT 162
#define HELPER_FAIL_EXIT 163
#define MAX_RESTRICTING_SIDS 4
#define NTSTATUS_ACCESS_DENIED 0xC0000022u

static void fail(const char *api) {
    DWORD err = GetLastError();
    fprintf(stderr, "pi-sandbox-win: %s failed %lu\n", api, (unsigned long)err);
    ExitProcess(HELPER_FAIL_EXIT);
}

static void failWin(const char *api, DWORD err) {
    SetLastError(err);
    fail(api);
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

/*
 * GRANT inheritable (OI|CI) Modify to trustee on an existing directory.
 * Capability SIDs stay out of TokenGroups; the ACE on disk is what
 * WRITE_RESTRICTED consults.
 */
static void grantInheritableModify(LPCWSTR path, PSID trustee) {
    PACL oldDacl = NULL;
    PACL newDacl = NULL;
    PSECURITY_DESCRIPTOR sd = NULL;
    EXPLICIT_ACCESS_W ea;
    DWORD err;

    ZeroMemory(&ea, sizeof(ea));
    ea.grfAccessPermissions = GENERIC_READ | GENERIC_WRITE | DELETE;
    ea.grfAccessMode = GRANT_ACCESS;
    ea.grfInheritance = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
    ea.Trustee.TrusteeForm = TRUSTEE_IS_SID;
    ea.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
    ea.Trustee.ptstrName = (LPWSTR)trustee;

    err = GetNamedSecurityInfoW(
        path,
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION,
        NULL,
        NULL,
        &oldDacl,
        NULL,
        &sd);
    if (err != ERROR_SUCCESS) {
        failWin("GetNamedSecurityInfoW", err);
    }

    err = SetEntriesInAclW(1, &ea, oldDacl, &newDacl);
    if (err != ERROR_SUCCESS) {
        LocalFree(sd);
        failWin("SetEntriesInAclW", err);
    }

    err = SetNamedSecurityInfoW(
        (LPWSTR)path,
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION,
        NULL,
        NULL,
        newDacl,
        NULL);
    LocalFree(newDacl);
    LocalFree(sd);
    if (err != ERROR_SUCCESS) {
        failWin("SetNamedSecurityInfoW", err);
    }
}

static void setTokenDefaultDacl(HANDLE token, PSID *sids, DWORD count) {
    DWORD needed = 0;
    PTOKEN_DEFAULT_DACL existing = NULL;
    PACL oldDacl = NULL;
    EXPLICIT_ACCESS_W eas[MAX_RESTRICTING_SIDS];
    PACL dacl = NULL;
    TOKEN_DEFAULT_DACL info;
    DWORD i;
    DWORD err;

    GetTokenInformation(token, TokenDefaultDacl, NULL, 0, &needed);
    if (needed > 0) {
        existing = (PTOKEN_DEFAULT_DACL)LocalAlloc(LMEM_FIXED | LMEM_ZEROINIT, needed);
        if (!existing) {
            fail("LocalAlloc");
        }
        if (!GetTokenInformation(token, TokenDefaultDacl, existing, needed, &needed)) {
            LocalFree(existing);
            fail("GetTokenInformation");
        }
        oldDacl = existing->DefaultDacl;
    }

    ZeroMemory(eas, sizeof(eas));
    for (i = 0; i < count; i++) {
        eas[i].grfAccessPermissions = GENERIC_READ | GENERIC_WRITE | DELETE;
        eas[i].grfAccessMode = GRANT_ACCESS;
        eas[i].grfInheritance = 0;
        eas[i].Trustee.TrusteeForm = TRUSTEE_IS_SID;
        eas[i].Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
        eas[i].Trustee.ptstrName = (LPWSTR)sids[i];
    }
    err = SetEntriesInAclW(count, eas, oldDacl, &dacl);
    if (err != ERROR_SUCCESS) {
        if (existing) {
            LocalFree(existing);
        }
        failWin("SetEntriesInAclW", err);
    }
    info.DefaultDacl = dacl;
    if (!SetTokenInformation(token, TokenDefaultDacl, &info, sizeof(info))) {
        LocalFree(dacl);
        if (existing) {
            LocalFree(existing);
        }
        fail("SetTokenInformation");
    }
    LocalFree(dacl);
    if (existing) {
        LocalFree(existing);
    }
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

static void addInheritHandle(HANDLE *list, DWORD *n, HANDLE h) {
    DWORD i;
    if (!h || h == INVALID_HANDLE_VALUE) {
        return;
    }
    for (i = 0; i < *n; i++) {
        if (list[i] == h) {
            return;
        }
    }
    list[(*n)++] = h;
    SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
}

static int run(int argc, wchar_t **argv) {
    LPCWSTR workspacePath = NULL;
    LPCWSTR workspaceSidText = NULL;
    LPCWSTR tempPath = NULL;
    LPCWSTR tempSidText = NULL;
    int commandIndex = -1;
    int i;
    HANDLE processToken = NULL;
    HANDLE restricted = NULL;
    HANDLE primary = NULL;
    PSID restrictingSids[MAX_RESTRICTING_SIDS];
    SID_AND_ATTRIBUTES sidAttrs[MAX_RESTRICTING_SIDS];
    PSID everyoneSid = NULL;
    PSID workspaceSid = NULL;
    PSID tempSid = NULL;
    PSID defaultDaclSids[2];
    DWORD defaultDaclCount = 0;
    DWORD sidCount = 0;
    DWORD flags;
    wchar_t *commandLine;
    STARTUPINFOEXW siex;
    SIZE_T attrSize = 0;
    HANDLE inherit[3];
    DWORD inheritCount = 0;
    PROCESS_INFORMATION pi;
    DWORD wait;
    DWORD exitCode;

    ZeroMemory(restrictingSids, sizeof(restrictingSids));
    ZeroMemory(sidAttrs, sizeof(sidAttrs));
    ZeroMemory(&siex, sizeof(siex));
    ZeroMemory(&pi, sizeof(pi));

    for (i = 1; i < argc; i++) {
        if (wcscmp(argv[i], L"--") == 0) {
            commandIndex = i + 1;
            break;
        }
        if (wcscmp(argv[i], L"--workspace") == 0) {
            if (i + 1 >= argc) {
                fail("argv");
            }
            workspacePath = argv[++i];
            continue;
        }
        if (wcscmp(argv[i], L"--workspace-sid") == 0) {
            if (i + 1 >= argc) {
                fail("argv");
            }
            workspaceSidText = argv[++i];
            continue;
        }
        if (wcscmp(argv[i], L"--temp") == 0) {
            if (i + 1 >= argc) {
                fail("argv");
            }
            tempPath = argv[++i];
            continue;
        }
        if (wcscmp(argv[i], L"--temp-sid") == 0) {
            if (i + 1 >= argc) {
                fail("argv");
            }
            tempSidText = argv[++i];
            continue;
        }
        fail("argv");
    }

    if (commandIndex < 0 || commandIndex >= argc) {
        fail("argv");
    }
    if (!tempPath) {
        fail("argv");
    }
    if ((workspacePath == NULL) != (workspaceSidText == NULL)) {
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

    everyoneSid = sidFromString(L"S-1-1-0", "ConvertStringSidToSid");
    restrictingSids[sidCount++] = logonSidFromToken(processToken);
    restrictingSids[sidCount++] = copySid(everyoneSid);
    if (workspaceSidText) {
        workspaceSid = sidFromString(workspaceSidText, "ConvertStringSidToSid");
        restrictingSids[sidCount++] = copySid(workspaceSid);
    }
    if (tempSidText) {
        tempSid = sidFromString(tempSidText, "ConvertStringSidToSid");
        restrictingSids[sidCount++] = copySid(tempSid);
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

    /* Directory ACL stamp — never add capability SIDs to TokenGroups. */
    if (workspacePath && workspaceSid) {
        grantInheritableModify(workspacePath, workspaceSid);
    }
    if (tempPath) {
        grantInheritableModify(tempPath, tempSid ? tempSid : everyoneSid);
    }

    if (workspaceSid && tempSid) {
        defaultDaclSids[defaultDaclCount++] = workspaceSid;
        defaultDaclSids[defaultDaclCount++] = tempSid;
    } else {
        defaultDaclSids[defaultDaclCount++] = everyoneSid;
    }
    setTokenDefaultDacl(primary, defaultDaclSids, defaultDaclCount);

    commandLine = buildCommandLine(argc - commandIndex, argv + commandIndex);

    addInheritHandle(inherit, &inheritCount, GetStdHandle(STD_INPUT_HANDLE));
    addInheritHandle(inherit, &inheritCount, GetStdHandle(STD_OUTPUT_HANDLE));
    addInheritHandle(inherit, &inheritCount, GetStdHandle(STD_ERROR_HANDLE));

    siex.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    siex.StartupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    siex.StartupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    siex.StartupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);

    /*
     * inheritCount > 0: TRUE + HANDLE_LIST whitelist.
     * inheritCount == 0: FALSE and no HANDLE_LIST (TRUE without a list
     * would inherit every inheritable handle).
     */
    if (inheritCount > 0) {
        siex.StartupInfo.cb = sizeof(siex);
        InitializeProcThreadAttributeList(NULL, 1, 0, &attrSize);
        siex.lpAttributeList = (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(
            GetProcessHeap(),
            HEAP_ZERO_MEMORY,
            attrSize);
        if (!siex.lpAttributeList) {
            fail("HeapAlloc");
        }
        if (!InitializeProcThreadAttributeList(siex.lpAttributeList, 1, 0, &attrSize)) {
            fail("InitializeProcThreadAttributeList");
        }
        if (!UpdateProcThreadAttribute(
                siex.lpAttributeList,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                inherit,
                inheritCount * sizeof(HANDLE),
                NULL,
                NULL)) {
            fail("UpdateProcThreadAttribute");
        }
    } else {
        siex.StartupInfo.cb = sizeof(STARTUPINFOW);
    }

    if (!CreateProcessAsUserW(
            primary,
            NULL,
            commandLine,
            NULL,
            NULL,
            inheritCount > 0,
            inheritCount > 0 ? EXTENDED_STARTUPINFO_PRESENT : 0,
            NULL,
            NULL,
            &siex.StartupInfo,
            &pi)) {
        fail("CreateProcessAsUserW");
    }

    if (siex.lpAttributeList) {
        DeleteProcThreadAttributeList(siex.lpAttributeList);
        HeapFree(GetProcessHeap(), 0, siex.lpAttributeList);
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
    if (workspaceSid) {
        LocalFree(workspaceSid);
    }
    if (tempSid) {
        LocalFree(tempSid);
    }
    if (everyoneSid) {
        LocalFree(everyoneSid);
    }

    /* 162 maps only these two child codes; bash exit 1 uses denialSignatures. */
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
