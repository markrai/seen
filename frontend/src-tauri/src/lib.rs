use tauri::Manager;
use tauri_plugin_shell::ShellExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // Spawn the backend sidecar
      let sidecar_command = app.shell().sidecar("seen-backend").unwrap();
      let (mut _rx, _child) = sidecar_command.spawn().expect("Failed to spawn backend sidecar");

      // Optionally log sidecar output in debug mode
      if cfg!(debug_assertions) {
        tauri::async_runtime::spawn(async move {
          use tauri_plugin_shell::process::CommandEvent;
          while let Some(event) = _rx.recv().await {
            match event {
              CommandEvent::Stdout(line) => {
                log::info!("[backend] {}", String::from_utf8_lossy(&line));
              }
              CommandEvent::Stderr(line) => {
                log::warn!("[backend] {}", String::from_utf8_lossy(&line));
              }
              CommandEvent::Error(err) => {
                log::error!("[backend] Error: {}", err);
              }
              CommandEvent::Terminated(payload) => {
                log::info!("[backend] Terminated with code: {:?}", payload.code);
                break;
              }
              _ => {}
            }
          }
        });
      }

      // Get the main window and adjust its size to fit the monitor
      // Try to get the window by label "main" first, otherwise get the first available window
      let window = app.get_webview_window("main")
        .or_else(|| app.webview_windows().values().next().cloned());

      if let Some(window) = window {
        // Get the monitor where the window will be displayed
        // Try current_monitor first, then fall back to available monitors
        let monitor = window.current_monitor()
          .ok()
          .flatten()
          .or_else(|| {
            // Fallback: get the first available monitor (usually primary)
            window.available_monitors()
              .ok()
              .and_then(|monitors| monitors.first().cloned())
          });

        if let Some(monitor) = monitor {
          let monitor_size = monitor.size();
          let monitor_width = monitor_size.width as f64;
          let monitor_height = monitor_size.height as f64;

          // Get current window size from config (1400x900)
          let config_width: f64 = 1400.0;
          let config_height: f64 = 900.0;

          // Calculate maximum usable size (leave some margin, e.g., 50px on each side)
          let margin = 50.0;
          let max_width = monitor_width - (margin * 2.0);
          let max_height = monitor_height - (margin * 2.0);

          // Adjust window size if it exceeds monitor dimensions
          let new_width = config_width.min(max_width).max(800.0); // Ensure minimum width
          let new_height = config_height.min(max_height).max(600.0); // Ensure minimum height

          // Only resize if the window is too large
          if new_width < config_width || new_height < config_height {
            if let Err(e) = window.set_size(tauri::LogicalSize::new(new_width, new_height)) {
              eprintln!("Failed to set window size: {:?}", e);
            } else {
              // Re-center the window after resizing
              if let Err(e) = window.center() {
                eprintln!("Failed to center window: {:?}", e);
              }
            }
          }
        }
      }

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
