use std::num::NonZeroUsize;
use std::sync::Arc;

use arena_alligator::FixedArena;
use bytes::BufMut;
use prost::Message;

use crate::config::AiresConfig;
use crate::error::{Error, Result};
use crate::proto;

/// Serialization pool backed by arena-alligator.
///
/// Pre-allocates a fixed arena for serializing proto EventBatch messages.
/// Each batch gets a lock-free arena slot instead of a heap allocation,
/// which avoids global allocator contention on the hot path.
///
/// The arena is configured with slots sized for the expected batch:
///   batch_size * ~512 bytes per event = slot capacity
///
/// If a batch exceeds slot capacity, auto-spill moves to heap transparently.
pub struct SerializePool {
    arena: Arc<FixedArena>,
}

fn nz(n: usize) -> NonZeroUsize {
    NonZeroUsize::new(n).expect("non-zero")
}

impl SerializePool {
    pub fn new(config: &AiresConfig) -> Result<Self> {
        // Each event serializes to roughly 256-1024 bytes.
        // Size slots for worst-case batch: batch_size * 1024 bytes.
        let slot_capacity = config.batch_size * 1024;
        // Keep enough slots for concurrent batches in flight (retries + new batch)
        let slot_count = (config.max_retries as usize + 2).max(4);

        let arena = FixedArena::with_slot_capacity(nz(slot_count), nz(slot_capacity))
            .auto_spill()
            .build()
            .map_err(|e| Error::Arena(format!("failed to create serialize pool: {e}")))?;

        Ok(Self {
            arena: Arc::new(arena),
        })
    }

    /// Serialize an EventBatch into arena-backed Bytes.
    /// Returns Bytes that can be passed directly to tonic.
    /// The arena slot is freed when the Bytes (and all clones/slices) are dropped.
    pub fn serialize_batch(&self, batch: &proto::EventBatch) -> Result<bytes::Bytes> {
        let encoded_len = batch.encoded_len();

        let mut buf = self
            .arena
            .allocate()
            .map_err(|e| Error::Arena(format!("arena allocate failed: {e}")))?;

        // Reserve and write
        if buf.remaining_mut() < encoded_len {
            // auto_spill handles this — the buffer will move to heap
            tracing::debug!(
                encoded_len,
                remaining = buf.remaining_mut(),
                "aires: batch exceeds arena slot, spilling to heap"
            );
        }

        batch
            .encode(&mut buf)
            .map_err(|e| Error::Serialize(format!("proto encode failed: {e}")))?;

        Ok(buf.freeze())
    }

    /// Get arena metrics for monitoring.
    pub fn metrics(&self) -> ArenaMetrics {
        let m = self.arena.metrics();
        ArenaMetrics {
            allocations: m.allocations_ok,
            failures: m.allocations_failed,
            spills: m.spills,
            live: m.frozen,
        }
    }
}

pub struct ArenaMetrics {
    pub allocations: u64,
    pub failures: u64,
    pub spills: u64,
    pub live: u64,
}
