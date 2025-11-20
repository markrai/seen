use anyhow::Result;
use std::process::Stdio;
use tokio::process::Command;

pub async fn exec_capture(cmd: &str, args: &[&str]) -> Result<(i32, Vec<u8>, Vec<u8>)> {
    let mut c = Command::new(cmd);
    c.args(args);
    c.stdin(Stdio::null());
    c.stdout(Stdio::piped());
    c.stderr(Stdio::piped());
    let output = c.spawn()?.wait_with_output().await?;
    let code = output.status.code().unwrap_or(-1);
    Ok((code, output.stdout, output.stderr))
}
