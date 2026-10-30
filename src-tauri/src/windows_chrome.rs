//! Windows 11 maximize hit-test overlay, adapted from tauri-plugin-frame 1.1.8.
//! Upstream: https://crates.io/crates/tauri-plugin-frame/1.1.8
//! MIT; see ../licenses/windows-chrome.txt. Kept locally to fix close-cancellation
//! teardown, report install errors, and avoid injected UI/scripts.
use std::{collections::HashMap, sync::Mutex};

use tauri::{Emitter, WebviewWindow};
use windows_sys::Win32::{
    Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, POINT, WPARAM},
    Graphics::Gdi::{GetStockObject, HBRUSH, NULL_BRUSH, ScreenToClient},
    System::LibraryLoader::GetModuleHandleW,
    UI::{
        HiDpi::GetDpiForWindow,
        Input::KeyboardAndMouse::{TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT, TrackMouseEvent},
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{
            CREATESTRUCTW, CS_HREDRAW, CS_VREDRAW, CreateWindowExW, DefWindowProcW, DestroyWindow,
            GetClientRect, HTMAXBUTTON, HWND_TOP, RegisterClassExW, SWP_ASYNCWINDOWPOS,
            SWP_SHOWWINDOW, SetWindowPos, WM_CREATE, WM_DPICHANGED, WM_NCDESTROY, WM_NCHITTEST,
            WM_NCLBUTTONDOWN, WM_NCLBUTTONUP, WM_NCMOUSELEAVE, WM_NCMOUSEMOVE, WM_SIZE,
            WNDCLASSEXW, WS_CHILD, WS_CLIPSIBLINGS, WS_OVERLAPPED, WS_VISIBLE,
        },
    },
};

use std::io;

const SNAP_CLASS: &[u16] = &[
    b'T' as u16,
    b'a' as u16,
    b'u' as u16,
    b'r' as u16,
    b'i' as u16,
    b'F' as u16,
    b'r' as u16,
    b'a' as u16,
    b'm' as u16,
    b'e' as u16,
    b'S' as u16,
    b'n' as u16,
    b'a' as u16,
    b'p' as u16,
    b'O' as u16,
    b'v' as u16,
    b'e' as u16,
    b'r' as u16,
    b'l' as u16,
    b'a' as u16,
    b'y' as u16,
    0,
];
const SUBCLASS_ID: usize = 0x7061_776e;
const EVENT_MOUSEENTER: &str = "tauri-frame://snap/mouseenter";
const EVENT_MOUSELEAVE: &str = "tauri-frame://snap/mouseleave";
const EVENT_MOUSEDOWN: &str = "tauri-frame://snap/mousedown";
const EVENT_MOUSEUP: &str = "tauri-frame://snap/mouseup";
const EVENT_CLICK: &str = "tauri-frame://snap/click";

static SNAP_WINDOWS: std::sync::LazyLock<Mutex<HashMap<isize, SnapState>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

struct SnapState {
    overlay: HWND,
    titlebar_height: u32,
    button_width: u32,
    right_index: u32, // number of buttons to the right of the maximize button
    hovering: bool,
    pressing: bool,
    last_x: i32,
    last_y: i32,
    emit: Box<dyn Fn(&'static str) + Send>,
    emit_move: Box<dyn Fn(i32, i32) + Send>,
}

unsafe impl Send for SnapState {}

/// Install once for the native window lifetime. In particular, cancelling a close
/// request must not tear down the snap hit-test overlay.
pub fn install(window: &WebviewWindow) -> io::Result<()> {
    let hwnd = window
        .hwnd()
        .map_err(|e| io::Error::other(e.to_string()))?
        .0 as isize;
    let target = window.clone();
    let moves = window.clone();
    unsafe {
        install_hwnd(
            hwnd,
            34,
            46,
            1,
            Box::new(move |event| {
                let _ = target.emit(event, ());
            }),
            Box::new(move |x, y| {
                let _ = moves.emit("tauri-frame://snap/mousemove", (x, y));
            }),
        )
    }
}

unsafe fn install_hwnd(
    hwnd: isize,
    titlebar_height: u32,
    button_width: u32,
    right_index: u32,
    emit: Box<dyn Fn(&'static str) + Send>,
    emit_move: Box<dyn Fn(i32, i32) + Send>,
) -> io::Result<()> {
    unsafe {
        register_class();

        let overlay = CreateWindowExW(
            0,
            SNAP_CLASS.as_ptr(),
            SNAP_CLASS.as_ptr(),
            WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | WS_OVERLAPPED,
            0,
            0,
            0,
            0,
            hwnd as HWND,
            std::ptr::null_mut(),
            module_instance(),
            std::ptr::null_mut(),
        );

        if overlay.is_null() {
            return Err(io::Error::last_os_error());
        }

        let old = SNAP_WINDOWS
            .lock()
            .expect("snap state poisoned")
            .remove(&hwnd);
        if let Some(old) = old {
            RemoveWindowSubclass(hwnd as HWND, Some(parent_subclass_proc), SUBCLASS_ID);
            DestroyWindow(old.overlay as _);
        }

        SNAP_WINDOWS.lock().expect("snap state poisoned").insert(
            hwnd,
            SnapState {
                overlay,
                titlebar_height,
                button_width,
                right_index,
                hovering: false,
                pressing: false,
                last_x: 0,
                last_y: 0,
                emit,
                emit_move,
            },
        );

        if SetWindowSubclass(hwnd as HWND, Some(parent_subclass_proc), SUBCLASS_ID, 0) == 0 {
            let error = io::Error::last_os_error();
            remove(hwnd as HWND);
            return Err(error);
        }
        update_overlay_position(hwnd as HWND);
        Ok(())
    }
}

unsafe fn register_class() {
    unsafe {
        let class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(overlay_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: module_instance(),
            hIcon: std::ptr::null_mut(),
            hCursor: std::ptr::null_mut(),
            hbrBackground: GetStockObject(NULL_BRUSH) as HBRUSH,
            lpszMenuName: std::ptr::null(),
            lpszClassName: SNAP_CLASS.as_ptr(),
            hIconSm: std::ptr::null_mut(),
        };
        RegisterClassExW(&class);
    }
}

unsafe fn module_instance() -> HINSTANCE {
    unsafe { GetModuleHandleW(std::ptr::null()) }
}

unsafe fn update_overlay_position(hwnd: HWND) {
    unsafe {
        let states = SNAP_WINDOWS.lock().expect("snap state poisoned");
        let Some(state) = states.get(&(hwnd as isize)) else {
            return;
        };

        let mut rect = std::mem::zeroed();
        if GetClientRect(hwnd, &mut rect) == 0 {
            return;
        }

        let dpi = GetDpiForWindow(hwnd);
        let scale = dpi as u64;
        let button_width = scaled(state.button_width, scale).max(1);
        let titlebar_height = scaled(state.titlebar_height, scale).max(1);
        let x = rect.right - (button_width * (state.right_index as i32 + 1));

        SetWindowPos(
            state.overlay,
            HWND_TOP,
            x,
            0,
            button_width,
            titlebar_height,
            SWP_ASYNCWINDOWPOS | SWP_SHOWWINDOW,
        );
    }
}

fn scaled(value: u32, dpi: u64) -> i32 {
    ((value as u64 * dpi + 48) / 96) as i32
}

unsafe fn remove(hwnd: HWND) {
    unsafe {
        RemoveWindowSubclass(hwnd as _, Some(parent_subclass_proc), SUBCLASS_ID);
        let state = SNAP_WINDOWS
            .lock()
            .expect("snap state poisoned")
            .remove(&(hwnd as isize));
        // DestroyWindow can synchronously deliver mouse-leave messages. Release
        // the map lock before calling back into the native window procedure.
        if let Some(state) = state {
            DestroyWindow(state.overlay as _);
        }
    }
}

unsafe fn emit(hwnd: HWND, event: &'static str) {
    if let Some(state) = SNAP_WINDOWS
        .lock()
        .expect("snap state poisoned")
        .get(&(hwnd as isize))
    {
        (state.emit)(event);
    }
}

unsafe extern "system" fn parent_subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _subclass_id: usize,
    _ref_data: usize,
) -> LRESULT {
    unsafe {
        match msg {
            WM_SIZE | WM_DPICHANGED => update_overlay_position(hwnd),
            WM_NCDESTROY => remove(hwnd),
            _ => {}
        }

        DefSubclassProc(hwnd, msg, wparam, lparam)
    }
}

unsafe extern "system" fn overlay_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    unsafe {
        match msg {
            WM_CREATE => {
                let createstruct = lparam as *const CREATESTRUCTW;
                if !createstruct.is_null() {
                    return 0;
                }
            }
            WM_NCHITTEST => return HTMAXBUTTON as LRESULT,
            WM_NCMOUSEMOVE => {
                if let Some(parent) = parent_for_overlay(hwnd) {
                    let mut point = POINT {
                        x: (lparam as i16) as i32,
                        y: ((lparam >> 16) as i16) as i32,
                    };
                    ScreenToClient(parent, &mut point);
                    let mut states = SNAP_WINDOWS.lock().expect("snap state poisoned");
                    if let Some(state) = states.get_mut(&(parent as isize)) {
                        if state.last_x != point.x || state.last_y != point.y {
                            state.last_x = point.x;
                            state.last_y = point.y;
                            (state.emit_move)(point.x, point.y);
                        }

                        if !state.hovering {
                            state.hovering = true;
                            drop(states);
                            emit(parent, EVENT_MOUSEENTER);
                        }
                    }

                    let mut track = TRACKMOUSEEVENT {
                        cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                        dwFlags: TME_LEAVE | TME_NONCLIENT,
                        hwndTrack: hwnd,
                        dwHoverTime: 0,
                    };
                    TrackMouseEvent(&mut track);
                }
                return 0;
            }
            WM_NCMOUSELEAVE => {
                if let Some(parent) = parent_for_overlay(hwnd) {
                    let mut states = SNAP_WINDOWS.lock().expect("snap state poisoned");
                    if let Some(state) = states.get_mut(&(parent as isize)) {
                        state.hovering = false;
                        state.pressing = false;
                    }
                    drop(states);
                    emit(parent, EVENT_MOUSELEAVE);
                }
                return 0;
            }
            WM_NCLBUTTONDOWN => {
                if let Some(parent) = parent_for_overlay(hwnd) {
                    let mut states = SNAP_WINDOWS.lock().expect("snap state poisoned");
                    if let Some(state) = states.get_mut(&(parent as isize)) {
                        state.pressing = true;
                    }
                    drop(states);
                    emit(parent, EVENT_MOUSEDOWN);
                }
                return 0;
            }
            WM_NCLBUTTONUP => {
                if let Some(parent) = parent_for_overlay(hwnd) {
                    let mut states = SNAP_WINDOWS.lock().expect("snap state poisoned");
                    let click = states
                        .get_mut(&(parent as isize))
                        .map(|state| {
                            let click = state.pressing;
                            state.pressing = false;
                            click
                        })
                        .unwrap_or(false);
                    drop(states);
                    emit(parent, EVENT_MOUSEUP);
                    if click {
                        emit(parent, EVENT_CLICK);
                    }
                }
                return 0;
            }
            _ => {}
        }

        DefWindowProcW(hwnd, msg, wparam, lparam)
    }
}

unsafe fn parent_for_overlay(overlay: HWND) -> Option<HWND> {
    let states = SNAP_WINDOWS.lock().expect("snap state poisoned");
    states
        .iter()
        .find_map(|(parent, state)| (state.overlay == overlay).then_some(*parent as HWND))
}
