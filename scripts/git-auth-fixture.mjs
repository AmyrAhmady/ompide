// A real authenticated Git smart-HTTPS endpoint. All keys, credentials and repositories
// belong to this disposable fixture; the user's credential vault is never modified.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:https";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function gitAuthFixture() {
  assert.equal(
    process.platform,
    "win32",
    "This GCM/DPAPI regression targets Windows."
  );
  const directory = await mkdtemp(path.join(tmpdir(), "pawn-git-auth-"));
  const repository = path.join(directory, "workspace");
  const remote = path.join(directory, "remote.git");
  const clone = path.join(directory, "other");
  const execPath = spawnSync("git", ["--exec-path"], {
    encoding: "utf8",
    windowsHide: true,
  }).stdout.trim();
  const openssl = path.resolve(execPath, "../../../usr/bin/openssl.exe");
  const manager = path.resolve(
    execPath,
    "../../bin/git-credential-manager.exe"
  );
  const backend = path.join(execPath, "git-http-backend.exe");
  const children = new Set();
  const sockets = new Set();
  const counts = {
    challenges: 0,
    authenticated: 0,
    upload: 0,
    receive: 0,
    hanging: 0,
  };
  const username = "pawn-fixture";
  const password = randomBytes(24).toString("hex");
  const expected = Buffer.from(
    `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
  );
  let mode = "ok";
  let server;

  function git(cwd, args, input) {
    const result = spawnSync(
      "git",
      [
        "-C",
        cwd,
        "-c",
        "credential.trace=false",
        "-c",
        "credential.traceSecrets=false",
        ...args,
      ],
      {
        input,
        encoding: "utf8",
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 2 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "never",
          GCM_TRACE: "0",
          GCM_TRACE_SECRETS: "0",
        },
      }
    );
    // No stderr/input in thrown assertions: credential helpers can carry sensitive data.
    assert.equal(
      result.status,
      0,
      `Fixture Git command ${args[0]} failed (${result.status}).`
    );
    return result.stdout.trim();
  }

  async function close() {
    for (const child of children) child.kill();
    for (const socket of sockets) socket.destroy();
    if (server?.listening)
      await new Promise((resolve) => server.close(resolve));
    const absolute = path.resolve(directory);
    assert.ok(
      path.dirname(absolute) === path.resolve(tmpdir()) &&
        path.basename(absolute).startsWith("pawn-git-auth-")
    );
    await rm(absolute, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }

  try {
    await Promise.all([access(openssl), access(manager), access(backend)]);
    await mkdir(repository);
    git(repository, ["init", "-b", "main"]);
    for (const [key, value] of [
      ["user.name", "Pawn auth fixture"],
      ["user.email", "fixture@example.invalid"],
      ["commit.gpgsign", "false"],
      ["core.autocrlf", "false"],
    ])
      git(repository, ["config", key, value]);
    await writeFile(path.join(repository, "main.txt"), "original source\n");
    git(repository, ["add", "--", "main.txt"]);
    git(repository, ["commit", "-m", "Initial fixture"]);
    git(directory, ["init", "--bare", remote]);
    git(remote, ["config", "http.receivepack", "true"]);
    const keyFile = path.join(directory, "server.key");
    const certFile = path.join(directory, "server.crt");
    const certificate = spawnSync(
      openssl,
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-noenc",
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-keyout",
        keyFile,
        "-out",
        certFile,
      ],
      { encoding: "utf8", windowsHide: true, timeout: 20000 }
    );
    assert.equal(
      certificate.status,
      0,
      "Could not generate the loopback-only fixture certificate."
    );
    server = createServer(
      { key: await readFile(keyFile), cert: await readFile(certFile) },
      (request, response) => {
        const authorization = Buffer.from(request.headers.authorization ?? "");
        const authenticated =
          authorization.length === expected.length &&
          timingSafeEqual(authorization, expected);
        if (mode === "deny" || !authenticated) {
          ++counts.challenges;
          response.writeHead(401, {
            "WWW-Authenticate": 'Basic realm="Pawn IDE regression"',
          });
          response.end("Authentication required");
          return;
        }
        ++counts.authenticated;
        if (mode === "hang") {
          ++counts.hanging;
          return;
        }
        if (["forbidden", "notfound", "unavailable"].includes(mode)) {
          response.writeHead(
            { forbidden: 403, notfound: 404, unavailable: 503 }[mode]
          );
          response.end("Fixture remote unavailable");
          return;
        }
        const url = new URL(request.url, "https://127.0.0.1");
        if (!url.pathname.startsWith("/remote.git/")) {
          response.writeHead(404);
          response.end();
          return;
        }
        const child = spawn(backend, [], {
          windowsHide: true,
          env: {
            ...process.env,
            GIT_PROJECT_ROOT: directory,
            GIT_HTTP_EXPORT_ALL: "1",
            PATH_INFO: url.pathname,
            QUERY_STRING: url.search.slice(1),
            REQUEST_METHOD: request.method,
            CONTENT_TYPE: request.headers["content-type"] ?? "",
            CONTENT_LENGTH: request.headers["content-length"] ?? "",
            REMOTE_USER: username,
            REMOTE_ADDR: "127.0.0.1",
            SERVER_PROTOCOL: "HTTP/1.1",
            GIT_PROTOCOL: request.headers["git-protocol"] ?? "",
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        children.add(child);
        if (request.url.includes("git-upload-pack")) ++counts.upload;
        if (request.url.includes("git-receive-pack")) ++counts.receive;
        request.pipe(child.stdin);
        child.stdin.on("error", () => undefined);
        child.stderr.resume();
        let header = Buffer.alloc(0);
        let started = false;
        child.stdout.on("data", (chunk) => {
          if (started) {
            response.write(chunk);
            return;
          }
          header = Buffer.concat([header, chunk]);
          const boundary = header.indexOf("\r\n\r\n");
          if (boundary < 0) return;
          let status = 200;
          const fields = {};
          for (const line of header
            .subarray(0, boundary)
            .toString("utf8")
            .split("\r\n")) {
            const colon = line.indexOf(":");
            if (colon < 0) continue;
            const name = line.slice(0, colon).toLowerCase();
            const value = line.slice(colon + 1).trim();
            if (name === "status") status = Number(value.split(" ")[0]);
            else fields[name] = value;
          }
          response.writeHead(status, fields);
          response.write(header.subarray(boundary + 4));
          header = Buffer.alloc(0);
          started = true;
        });
        child.on("error", () => {
          if (!response.headersSent) response.writeHead(500);
          response.end();
        });
        child.on("close", () => {
          children.delete(child);
          if (!started && !response.headersSent) response.writeHead(500);
          response.end();
        });
        response.on("close", () => {
          if (!response.writableFinished) child.kill();
        });
      }
    );
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const host = `127.0.0.1:${address.port}`;
    const url = `https://${host}/remote.git`;
    for (const [key, value] of [
      ["credential.helper", ""],
      ["credential.provider", "generic"],
      ["credential.interactive", "false"],
      ["credential.credentialStore", "dpapi"],
      ["credential.dpapiStorePath", path.join(directory, "credential-vault")],
      ["credential.useHttpPath", "true"],
      ["http.sslBackend", "openssl"],
      ["http.sslCAInfo", certFile],
      ["credential.trace", "true"],
      ["credential.traceSecrets", "true"],
    ])
      git(repository, ["config", key, value]);
    git(repository, [
      "config",
      "--add",
      "credential.helper",
      `!"${manager.replaceAll("\\", "/")}"`,
    ]);
    git(repository, ["remote", "add", "origin", url]);

    function credentials(valid = true) {
      git(
        repository,
        ["credential", "approve"],
        `protocol=https\nhost=${host}\npath=remote.git\nusername=${username}\npassword=${valid ? password : randomBytes(24).toString("hex")}\n\n`
      );
    }

    credentials();
    return {
      directory,
      repository,
      remote,
      clone,
      url,
      host,
      password,
      certFile,
      counts,
      git,
      credentials,
      setMode(value) {
        mode = value;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
