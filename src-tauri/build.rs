fn go_version(value: &serde_json::Value) -> Option<[u64; 3]> {
    let mut parts = value.as_str()?.strip_prefix("go")?.split('.');
    let version = [
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    ];
    parts.next().is_none().then_some(version)
}

fn main() {
    // Local source builds may use a newer compatible Go compiler. Bind their
    // recorded checksum into this application at build time; never trust a
    // workspace-supplied or runtime-edited checksum file.
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap();
    let (manifest, go_target) = match target_os.as_str() {
        "windows" => ("tools.json", "windows/amd64"),
        "linux" => ("tools-linux.json", "linux/amd64"),
        _ => panic!("Unsupported desktop target: {target_os}"),
    };
    let tools_path = root.join("../toolchain").join(manifest);
    println!(
        "cargo:rustc-env=OMPIDE_TOOL_MANIFEST={}",
        tools_path.display()
    );
    let source_path = root.join("../toolchain/pawnlsp-build.json");
    let record_path = root.join("binaries/licenses/pawnlsp-dependencies.json");
    for file in [&tools_path, &source_path, &record_path] {
        println!("cargo:rerun-if-changed={}", file.display());
    }
    let tools: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&tools_path).unwrap()).unwrap();
    let server = tools["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == "pawnlsp")
        .unwrap();
    println!(
        "cargo:rustc-env=OMPIDE_LSP_DESTINATION={}",
        server["destination"].as_str().unwrap()
    );
    let compiler = tools["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == "pawncc")
        .unwrap();
    println!(
        "cargo:rustc-env=OMPIDE_COMPILER_RELATIVE=binaries/{}",
        compiler["destination"].as_str().unwrap()
    );
    let mut checksum = server["executableSha256"].as_str().unwrap_or("").to_owned();
    match std::fs::read(record_path) {
        Ok(bytes) => {
            let record: serde_json::Value = serde_json::from_slice(&bytes)
                .expect("Invalid pawnlsp build record; run tools:prepare");
            let actual = record["executableSha256"]
                .as_str()
                .expect("Missing pawnlsp checksum");
            assert!(
                record["schemaVersion"] == 1
                    && actual.len() == 64
                    && actual.bytes().all(|byte| byte.is_ascii_hexdigit()),
                "Invalid pawnlsp build record; run tools:prepare"
            );
            if actual != checksum {
                let pin: serde_json::Value =
                    serde_json::from_slice(&std::fs::read(source_path).unwrap()).unwrap();
                let build = &record["build"];
                let minimum = go_version(&pin["minimumGoVersion"])
                    .expect("Invalid pinned minimum Go version");
                assert!(
                    build["version"] == pin["version"]
                        && build["sourceCommit"] == pin["source"]["commit"]
                        && build["sourceSha256"] == pin["source"]["sha256"]
                        && build["patchSha256"] == pin["patch"]["sha256"]
                        && build["modulePatchSha256"] == pin["modulePatch"]["sha256"]
                        && build["target"] == go_target
                        && go_version(&build["goVersion"])
                            .is_some_and(|version| version >= minimum),
                    "Stale pawnlsp source build; run tools:prepare"
                );
                checksum = actual.to_owned();
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => panic!("Cannot read pawnlsp build record: {error}"),
    }
    assert!(
        !checksum.is_empty(),
        "Prepare the source-built language server before building ompide"
    );
    println!("cargo:rustc-env=OMPIDE_LSP_SHA256={checksum}");
    tauri_build::build()
}
