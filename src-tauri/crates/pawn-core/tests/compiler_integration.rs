//! Explicit real-tool test; ordinary offline unit tests need no compiler installed.
use pawn_core::{compiler, project, workspace::Workspace};
use std::{fs, path::Path, sync::atomic::AtomicBool};

#[test]
#[ignore = "requires the prepared pinned open.mp compiler; run explicitly with --ignored"]
fn real_compiler_success_failure_constants_and_cancelled_artifacts() {
    let executable = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../binaries/compiler/pawnc-3.10.11-windows/bin/pawncc.exe");
    assert!(executable.is_file(), "prepare the pinned compiler first");
    let root = tempfile::Builder::new()
        .prefix("pawn-direct-compiler-")
        .tempdir()
        .unwrap();
    fs::create_dir(root.path().join("include")).unwrap();
    fs::write(
        root.path().join("include/helper.inc"),
        "stock Answer() { return 42; }\n",
    )
    .unwrap();
    fs::write(root.path().join("main.pwn"), "#include <helper>\n#if FEATURE != 1\n#error Missing constant\n#endif\nmain() { return Answer(); }\n").unwrap();
    let scope = Workspace::open(root.path()).unwrap();
    let configuration = project::build_configuration(&scope, &serde_json::json!({"entry":"main.pwn", "build":{"includes":["include"],"constants":{"FEATURE":true}}}), "").unwrap();
    let result =
        compiler::build(&scope, &configuration, &executable, &AtomicBool::new(false)).unwrap();
    assert_eq!(result.outcome, "completed");
    let report = result.report.unwrap();
    assert_eq!(
        report.status, "passed",
        "{}{}",
        report.process.stdout, report.process.stderr
    );
    assert!(report.artifacts[0].size > 56);
    assert!(report.process.stdout.contains("Pawn compiler 3.10.11"));
    fs::write(
        root.path().join("main.pwn"),
        "main() { MissingFunction(); }\n",
    )
    .unwrap();
    let result =
        compiler::build(&scope, &configuration, &executable, &AtomicBool::new(false)).unwrap();
    let report = result.report.unwrap();
    assert_eq!(report.status, "failed");
    assert!(
        report
            .diagnostics
            .iter()
            .any(|item| item.code == "pawncc-017" && item.primary.range.start.line == 0)
    );
    assert!(!root.path().join("output/main.amx").exists());
    fs::write(root.path().join("output/main.amx"), b"stale artifact").unwrap();
    let result =
        compiler::build(&scope, &configuration, &executable, &AtomicBool::new(true)).unwrap();
    assert_eq!(result.outcome, "cancelled");
    assert!(!root.path().join("output/main.amx").exists());
}
