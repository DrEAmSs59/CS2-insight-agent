//! Free and Pro share one data directory, so only one edition may run at a
//! time. Named mutexes vanish when their last handle closes, including when a
//! process crashes, so a stale lock can never block the next launch.

use crate::edition::Edition;

const NAMESPACE: &str = "Local\\CS2InsightAgent";

pub enum Acquire {
    Acquired(RuntimeLock),
    SameEditionRunning,
    OtherEditionRunning(Edition),
}

pub struct RuntimeLock {
    _marker: NamedMutex,
    _runtime: NamedMutex,
}

pub fn acquire(edition: Edition) -> Result<Acquire, String> {
    acquire_in(NAMESPACE, edition)
}

fn acquire_in(namespace: &str, edition: Edition) -> Result<Acquire, String> {
    // The marker is created before the shared lock so a rejected launch can
    // tell which edition holds the shared lock.
    let (marker, marker_existed) =
        NamedMutex::create(&format!("{namespace}.Edition.{}", edition.id()))?;
    if marker_existed {
        return Ok(Acquire::SameEditionRunning);
    }
    let (runtime, runtime_existed) = NamedMutex::create(&format!("{namespace}.Runtime"))?;
    if runtime_existed {
        return Ok(Acquire::OtherEditionRunning(edition.other()));
    }
    Ok(Acquire::Acquired(RuntimeLock {
        _marker: marker,
        _runtime: runtime,
    }))
}

pub fn show_conflict(current: Edition, running: Edition) {
    let running_name = running.display_name();
    let message = format!(
        "{running_name}正在运行。\n\n{}与{running_name}共用同一份数据，请先关闭{running_name}后再打开。",
        current.display_name()
    );
    show_warning(&message);
}

pub fn show_error(detail: &str) {
    show_warning(&format!("无法确认另一版 CS2 洞察是否正在运行：{detail}"));
}

#[cfg(windows)]
mod platform {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE},
        System::Threading::CreateMutexW,
        UI::WindowsAndMessaging::{MessageBoxW, MB_ICONWARNING, MB_OK},
    };

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub struct NamedMutex(HANDLE);

    impl NamedMutex {
        pub fn create(name: &str) -> Result<(Self, bool), String> {
            let name = wide(name);
            let handle = unsafe { CreateMutexW(null(), 0, name.as_ptr()) };
            let existed = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
            if handle.is_null() {
                return Err(format!("CreateMutexW 失败，错误码 {}", unsafe { GetLastError() }));
            }
            Ok((Self(handle), existed))
        }
    }

    impl Drop for NamedMutex {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    pub fn show_warning(message: &str) {
        let text = wide(message);
        let caption = wide("CS2 Insight Agent");
        unsafe {
            MessageBoxW(
                null_mut(),
                text.as_ptr(),
                caption.as_ptr(),
                MB_OK | MB_ICONWARNING,
            )
        };
    }
}

#[cfg(not(windows))]
mod platform {
    pub struct NamedMutex;

    impl NamedMutex {
        pub fn create(_name: &str) -> Result<(Self, bool), String> {
            Ok((Self, false))
        }
    }

    pub fn show_warning(message: &str) {
        eprintln!("{message}");
    }
}

use platform::{show_warning, NamedMutex};

#[cfg(all(test, windows))]
mod tests {
    use super::{acquire_in, Acquire};
    use crate::edition::Edition;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn namespace() -> String {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        format!(
            "Local\\CS2InsightAgentTest.{}.{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        )
    }

    #[test]
    fn other_edition_is_reported_while_one_edition_runs() {
        let ns = namespace();
        let free = acquire_in(&ns, Edition::Free).unwrap();
        assert!(matches!(free, Acquire::Acquired(_)));
        assert!(matches!(
            acquire_in(&ns, Edition::Pro).unwrap(),
            Acquire::OtherEditionRunning(Edition::Free)
        ));
    }

    #[test]
    fn same_edition_is_left_to_the_single_instance_plugin() {
        let ns = namespace();
        let _pro = acquire_in(&ns, Edition::Pro).unwrap();
        assert!(matches!(
            acquire_in(&ns, Edition::Pro).unwrap(),
            Acquire::SameEditionRunning
        ));
    }

    #[test]
    fn lock_is_released_when_the_holder_exits() {
        let ns = namespace();
        let free = acquire_in(&ns, Edition::Free).unwrap();
        drop(free);
        assert!(matches!(
            acquire_in(&ns, Edition::Pro).unwrap(),
            Acquire::Acquired(_)
        ));
    }

    #[test]
    fn rejected_edition_does_not_keep_its_marker() {
        let ns = namespace();
        let free = acquire_in(&ns, Edition::Free).unwrap();
        assert!(matches!(
            acquire_in(&ns, Edition::Pro).unwrap(),
            Acquire::OtherEditionRunning(Edition::Free)
        ));
        drop(free);
        let _pro = acquire_in(&ns, Edition::Pro).unwrap();
        assert!(matches!(
            acquire_in(&ns, Edition::Free).unwrap(),
            Acquire::OtherEditionRunning(Edition::Pro)
        ));
    }
}
