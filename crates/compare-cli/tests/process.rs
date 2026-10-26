use std::process::Command;

#[test]
fn cli_exit_codes_and_output_integrity() {
  if std::env::var_os("COMPARE_CLI_TEST_CHILD").is_some() {
    assert_eq!(std::env::var("COMPARE_WAIT_FOR_CLOSE").unwrap(), "1");
    std::thread::sleep(std::time::Duration::from_millis(150));
    return;
  }
  let root = tempfile::tempdir().unwrap();
  let a = root.path().join("a.txt");
  let b = root.path().join("b.txt");
  let c = root.path().join("c.txt");
  let output = root.path().join("output.txt");
  std::fs::write(&a, "a\n").unwrap();
  std::fs::write(&b, "a\n").unwrap();
  std::fs::write(&c, "b\n").unwrap();
  let run = |args: &[&std::ffi::OsStr]| {
    Command::new(env!("CARGO_BIN_EXE_compare"))
      .args(args)
      .output()
      .unwrap()
      .status
      .code()
      .unwrap()
  };
  assert_eq!(run(&["diff".as_ref(), a.as_os_str(), b.as_os_str()]), 0);
  assert_eq!(run(&["diff".as_ref(), a.as_os_str(), c.as_os_str()]), 1);
  assert_eq!(run(&["invalid".as_ref()]), 2);
  assert_eq!(
    run(&[
      "merge".as_ref(),
      a.as_os_str(),
      c.as_os_str(),
      b.as_os_str(),
      output.as_os_str()
    ]),
    0
  );
  assert_eq!(std::fs::read_to_string(&output).unwrap(), "b\n");
  assert_eq!(
    run(&[
      "merge".as_ref(),
      a.as_os_str(),
      c.as_os_str(),
      b.as_os_str(),
      output.as_os_str()
    ]),
    2
  );
  std::fs::write(&b, "different\n").unwrap();
  let never_created = root.path().join("conflict.txt");
  assert_eq!(
    run(&[
      "merge".as_ref(),
      a.as_os_str(),
      c.as_os_str(),
      b.as_os_str(),
      never_created.as_os_str()
    ]),
    1
  );
  assert!(!never_created.exists());
  let started = std::time::Instant::now();
  let status = Command::new(env!("CARGO_BIN_EXE_compare"))
    .arg("gui")
    .env("COMPARE_DESKTOP", std::env::current_exe().unwrap())
    .env("COMPARE_CLI_TEST_CHILD", "1")
    .status()
    .unwrap();
  assert!(status.success());
  assert!(started.elapsed() >= std::time::Duration::from_millis(150));
}
