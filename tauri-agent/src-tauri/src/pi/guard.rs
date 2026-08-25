//! 进程守卫：保证 Tauri 主进程一旦消失（含崩溃 / 被强杀），由它拉起的托管 sidecar
//! （及其孙进程）被操作系统兜底回收，不会变成长期存在的孤儿进程。
//!
//! Windows 实现用 Job Object + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`：把每个托管 sidecar
//! 加进 job，主进程持有 job 句柄。当主进程因任何原因退出，OS 关闭其最后一个 job 句柄，
//! 触发 kill-on-close，job 内全部进程被终止。这是不依赖父进程跑任何清理代码的 OS 级保证。
//!
//! Linux 额外给托管的 Node 子进程设置 `PR_SET_PDEATHSIG`；macOS 依赖正常退出清理和
//! cli 侧 stdin-EOF 自杀（尚无等价的内核 job object）。

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;

    use anyhow::{anyhow, Result};
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, FALSE, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    /// 持有一个配置了 kill-on-close 的 Job Object 句柄。
    pub struct ProcessGuard {
        job: HANDLE,
    }

    // 句柄只用于 OS 调用（job 分配在内核侧自带同步），跨线程共享安全。
    // 故意不实现 Drop：进程退出时由 OS 关闭句柄，正好触发 kill-on-close 回收子进程。
    unsafe impl Send for ProcessGuard {}
    unsafe impl Sync for ProcessGuard {}

    impl ProcessGuard {
        pub fn new() -> Result<Self> {
            unsafe {
                let job = CreateJobObjectW(None, PCWSTR::null())
                    .map_err(|e| anyhow!("CreateJobObjectW failed: {e}"))?;

                let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
                .map_err(|e| anyhow!("SetInformationJobObject failed: {e}"))?;

                Ok(Self { job })
            }
        }

        /// 把指定 pid 的进程加入 job。调用方必须把失败视为监督建立失败，
        /// 不能继续启动依赖 kill-on-close 保证的托管服务。
        pub fn assign(&self, pid: u32) -> Result<()> {
            unsafe {
                let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, FALSE, pid)
                    .map_err(|e| anyhow!("OpenProcess({pid}) failed: {e}"))?;
                let result = AssignProcessToJobObject(self.job, process);
                // 分配完即可释放进程句柄：job 对成员的引用独立于此句柄。
                let _ = CloseHandle(process);
                result.map_err(|e| anyhow!("AssignProcessToJobObject({pid}) failed: {e}"))?;
                Ok(())
            }
        }

        #[cfg(test)]
        pub(crate) fn close_for_test(self) -> Result<()> {
            unsafe {
                CloseHandle(self.job).map_err(|e| anyhow!("CloseHandle(ProcessGuard) failed: {e}"))
            }
        }
    }

    pub fn prepare_command(_command: &mut std::process::Command) -> Result<()> {
        Ok(())
    }
}

#[cfg(not(windows))]
mod imp {
    use anyhow::Result;
    use std::io;
    use std::os::unix::process::CommandExt;
    use std::process::Command;

    /// Unix 下保留一个轻量句柄；Linux 的父死信号由 `prepare_command` 设置。
    pub struct ProcessGuard;

    impl ProcessGuard {
        pub fn new() -> Result<Self> {
            Ok(Self)
        }

        pub fn assign(&self, _pid: u32) -> Result<()> {
            Ok(())
        }
    }

    pub fn prepare_command(command: &mut Command) -> Result<()> {
        let parent_pid = std::process::id() as libc::pid_t;
        unsafe {
            command.pre_exec(move || {
                #[cfg(target_os = "linux")]
                {
                    if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                        return Err(io::Error::last_os_error());
                    }
                    // Setting the signal before checking the parent closes both sides
                    // of the fork race: a prior exit changes PPID, a later exit signals.
                    if libc::getppid() != parent_pid {
                        return Err(io::Error::new(
                            io::ErrorKind::Interrupted,
                            "parent exited before spawn",
                        ));
                    }
                }
                // Isolate the service in its own process group for explicit shutdown.
                if libc::setsid() == -1 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        Ok(())
    }
}

pub use imp::{prepare_command, ProcessGuard};
