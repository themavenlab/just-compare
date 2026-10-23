use std::process::Command;

#[test]
fn cli_exit_codes_and_output_integrity() {
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
}
