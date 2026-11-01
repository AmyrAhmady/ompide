//! Explicit real-tool test; ordinary offline unit tests need no compiler installed.
use pawn_core::{compiler, project, workspace::Workspace};
use std::{fs, path::Path, sync::atomic::AtomicBool};

#[test]
#[ignore = "requires the prepared pinned open.mp compiler; run explicitly with --ignored"]
fn real_compiler_success_failure_constants_and_cancelled_artifacts() {
    let relative = if cfg!(target_os = "linux") {
        "../../binaries/compiler/pawnc-3.10.11-linux/bin/pawncc"
    } else {
        "../../binaries/compiler/pawnc-3.10.11-windows/bin/pawncc.exe"
    };
    let executable = Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
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

#[test]
#[ignore = "requires the prepared pinned open.mp compiler; run explicitly with --ignored"]
fn real_compiler_accepts_shared_sdk_inputs_and_reports_external_header_errors() {
    let relative = if cfg!(target_os = "linux") {
        "../../binaries/compiler/pawnc-3.10.11-linux/bin/pawncc"
    } else {
        "../../binaries/compiler/pawnc-3.10.11-windows/bin/pawncc.exe"
    };
    let executable = Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
    let parent = tempfile::tempdir().unwrap();
    let root = parent.path().join("project");
    let sdk = parent.path().join("shared SDK");
    fs::create_dir(&root).unwrap();
    fs::create_dir(&sdk).unwrap();
    let header = sdk.join("shared.inc");
    let original = "stock SharedAnswer() { return 42; }\n";
    fs::write(&header, original).unwrap();
    fs::write(
        root.join("main.pwn"),
        "#include <shared>\nmain() { return SharedAnswer(); }\n",
    )
    .unwrap();
    let scope = Workspace::open(&root).unwrap();
    for configuration in [
        serde_json::json!({"entry":"main.pwn", "include_path":sdk}),
        serde_json::json!({"entry":"main.pwn", "pawnkit":{"includePaths":["../shared SDK"]}}),
        serde_json::json!({"entry":"main.pwn", "build":{"includes":[sdk.clone()]}}),
        serde_json::json!({"entry":"main.pwn", "build":{"args":["-i../shared SDK"]}}),
    ] {
        let configuration = project::build_configuration(&scope, &configuration, "").unwrap();
        let result =
            compiler::build(&scope, &configuration, &executable, &AtomicBool::new(false)).unwrap();
        let report = result.report.unwrap();
        assert_eq!(
            report.status, "passed",
            "{}{}",
            report.process.stdout, report.process.stderr
        );
        assert!(root.join("output/main.amx").is_file());
        assert_eq!(fs::read_to_string(&header).unwrap(), original);
        assert!(!sdk.join("output").exists());
    }
    fs::write(
        &header,
        "stock SharedAnswer() { return MissingSdkSymbol(); }\n",
    )
    .unwrap();
    let configuration = project::build_configuration(
        &scope,
        &serde_json::json!({"entry":"main.pwn", "build":{"args":["-i../shared SDK"]}}),
        "",
    )
    .unwrap();
    let result =
        compiler::build(&scope, &configuration, &executable, &AtomicBool::new(false)).unwrap();
    let report = result.report.unwrap();
    assert_eq!(report.status, "failed");
    let expected =
        pawn_core::workspace::file_uri(&pawn_core::workspace::canonical(&header).unwrap()).unwrap();
    assert!(
        report
            .diagnostics
            .iter()
            .any(|item| item.code == "pawncc-017" && item.primary.uri == expected),
        "{}{}",
        report.process.stdout,
        report.process.stderr
    );
    assert!(!root.join("output/main.amx").exists());
}
