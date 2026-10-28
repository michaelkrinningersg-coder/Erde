// Desktop-Hülle für die Erde-App: zeigt die gebaute Web-App im Windows-eigenen WebView2-Fenster.
// Ohne Konsolenfenster unter Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("Erde konnte nicht gestartet werden");
}
