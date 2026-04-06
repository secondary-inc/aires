use thiserror::Error;

#[derive(Error, Debug)]
pub enum Error {
    #[error("configuration error: {0}")]
    Config(String),

    #[error("connection failed: {0}")]
    Connection(String),

    #[error("grpc error: {0}")]
    Grpc(#[from] tonic::Status),

    #[error("transport error: {0}")]
    Transport(#[from] tonic::transport::Error),

    #[error("serialization error: {0}")]
    Serialize(String),

    #[error("batch queue full ({capacity} events)")]
    BackPressure { capacity: usize },

    #[error("sdk not initialized")]
    NotInitialized,

    #[error("flush timeout after {0:?}")]
    FlushTimeout(std::time::Duration),

    #[error("arena allocation failed: {0}")]
    Arena(String),

    #[error("{0}")]
    Other(#[from] Box<dyn std::error::Error + Send + Sync>),
}

pub type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn config_error_display() {
        let err = Error::Config("bad value".into());
        assert_eq!(err.to_string(), "configuration error: bad value");
    }

    #[test]
    fn backpressure_error_display() {
        let err = Error::BackPressure { capacity: 1024 };
        assert_eq!(err.to_string(), "batch queue full (1024 events)");
    }

    #[test]
    fn flush_timeout_display() {
        let err = Error::FlushTimeout(Duration::from_secs(5));
        assert_eq!(err.to_string(), "flush timeout after 5s");
    }

    #[test]
    fn not_initialized_display() {
        let err = Error::NotInitialized;
        assert_eq!(err.to_string(), "sdk not initialized");
    }

    #[test]
    fn error_is_send_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<Error>();
    }

    #[test]
    fn from_grpc_status() {
        let status = tonic::Status::not_found("missing");
        let err: Error = status.into();
        assert!(matches!(err, Error::Grpc(_)));
        assert!(err.to_string().contains("missing"));
    }
}
