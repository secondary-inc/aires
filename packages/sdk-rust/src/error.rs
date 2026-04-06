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
