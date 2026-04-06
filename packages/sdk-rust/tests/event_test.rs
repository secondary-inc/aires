use aires_sdk::Severity;

#[test]
fn severity_copy_and_eq() {
    let a = Severity::Info;
    let b = a;
    assert_eq!(a, b);
}

#[test]
fn severity_ne() {
    assert_ne!(Severity::Trace, Severity::Fatal);
    assert_ne!(Severity::Debug, Severity::Error);
    assert_ne!(Severity::Info, Severity::Warn);
}

#[test]
fn severity_debug_format() {
    assert_eq!(format!("{:?}", Severity::Info), "Info");
    assert_eq!(format!("{:?}", Severity::Error), "Error");
}

#[test]
fn all_severity_variants_distinct() {
    let variants = [
        Severity::Trace,
        Severity::Debug,
        Severity::Info,
        Severity::Warn,
        Severity::Error,
        Severity::Fatal,
    ];

    for (i, a) in variants.iter().enumerate() {
        for (j, b) in variants.iter().enumerate() {
            if i == j {
                assert_eq!(a, b);
            } else {
                assert_ne!(a, b);
            }
        }
    }
}
