fn main() -> Result<(), Box<dyn std::error::Error>> {
    // The SDK consumes the collector API; it does not host a gRPC server.
    tonic_build::configure()
        .build_server(false)
        .compile_protos(&["../../proto/aires.proto"], &["../../proto"])?;
    Ok(())
}
