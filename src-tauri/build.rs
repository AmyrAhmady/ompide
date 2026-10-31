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
    let tools_path = root.join("../toolchain/tools.json");
    let source_path = root.join("../toolchain/pawnlsp-build.json");
    let record_path = root.join("binaries/licenses/pawnlsp-dependencies.json");
    for file in [&tools_path, &source_path, &record_path] {
        println!("cargo:rerun-if-changed={}", file.display());
    }
    let tools: serde_json::Value =
        serde_json::from_slice(&std::fs::read(tools_path).unwrap()).unwrap();
    let server = tools["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == "pawnlsp")
        .unwrap();
    let mut checksum = server["executableSha256"].as_str().unwrap().to_owned();
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
                        && build["target"] == "windows/amd64"
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
    println!("cargo:rustc-env=OMPIDE_LSP_SHA256={checksum}");
    tauri_build::build()
}
