//! Integration harness for the same process/framing service used by Tauri IPC.
//! stdin: one complete JSON-RPC object per line; stdout: serialized LspEvent per line.
use pawn_core::lsp::{LspEvent, LspSession};
use std::{
    io::{self, BufRead, Write},
    path::Path,
    sync::{Arc, Mutex},
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        return Err("usage: pawn-lsp-bridge EXECUTABLE WORKSPACE".into());
    }
    let stdout = Arc::new(Mutex::new(io::stdout()));
    let output = Arc::clone(&stdout);
    let mut session = LspSession::start(
        Path::new(&args[1]),
        Path::new(&args[2]),
        move |event: LspEvent| {
            let mut output = output.lock().expect("stdout lock");
            let _ = serde_json::to_writer(&mut *output, &event);
            let _ = writeln!(output);
            let _ = output.flush();
        },
    )?;
    for line in io::stdin().lock().lines() {
        session.send(&line?)?;
    }
    session.stop();
    Ok(())
}
