use tonic::transport::{Channel, ClientTlsConfig};
use prost::Message;

use crate::config::AiresConfig;
use crate::error::{Error, Result};
use crate::proto;
use crate::proto::aires_collector_client::AiresCollectorClient;

#[derive(Clone)]
pub struct GrpcClient {
    inner: AiresCollectorClient<Channel>,
}

impl GrpcClient {
    pub async fn connect(config: &AiresConfig) -> Result<Self> {
        let mut endpoint = Channel::from_shared(config.endpoint.clone())
            .map_err(|e| Error::Connection(e.to_string()))?;

        if config.tls {
            let tls = ClientTlsConfig::new();
            endpoint = endpoint.tls_config(tls)?;
        }

        let channel = endpoint
            .connect()
            .await
            .map_err(|e| Error::Connection(format!("failed to connect to {}: {e}", config.endpoint)))?;

        let client = AiresCollectorClient::new(channel);

        Ok(Self { inner: client })
    }

    pub async fn ingest(&self, batch: proto::EventBatch) -> Result<proto::IngestResponse> {
        let mut client = self.inner.clone();
        let response = client.ingest(batch).await?;
        Ok(response.into_inner())
    }

    /// Ingest pre-serialized bytes (from arena-backed pool).
    /// Decodes the batch from raw bytes and sends via gRPC.
    pub async fn ingest_raw(&self, payload: bytes::Bytes) -> Result<proto::IngestResponse> {
        let batch = proto::EventBatch::decode(payload)
            .map_err(|e| Error::Serialize(format!("failed to decode batch: {e}")))?;
        self.ingest(batch).await
    }
}
