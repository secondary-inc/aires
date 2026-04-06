use std::num::NonZeroUsize;

use arena_alligator::FixedArena;
use criterion::{Criterion, black_box, criterion_group, criterion_main};
use prost::Message;

// Include proto definitions
mod proto {
    tonic::include_proto!("aires.v1");
}

fn make_event(i: usize) -> proto::Event {
    proto::Event {
        id: format!("evt-{i}"),
        timestamp_ns: 1_704_067_200_000_000_000 + i as u64,
        service: "bench-svc".into(),
        environment: "bench".into(),
        severity: 3, // info
        message: format!("benchmark event number {i}"),
        kind: "log".into(),
        category: "bench".into(),
        trace_id: format!("trace-{}", i % 100),
        session_id: format!("sess-{}", i % 10),
        user_id: format!("user-{}", i % 5),
        ..Default::default()
    }
}

fn make_batch(size: usize) -> proto::EventBatch {
    proto::EventBatch {
        events: (0..size).map(make_event).collect(),
        sdk_name: "aires-sdk-rust".into(),
        sdk_version: "0.1.0".into(),
        sdk_language: "rust".into(),
    }
}

fn bench_event_creation(c: &mut Criterion) {
    c.bench_function("event_create", |b| {
        let mut i = 0usize;
        b.iter(|| {
            i += 1;
            black_box(make_event(i));
        })
    });
}

fn bench_proto_encode_heap(c: &mut Criterion) {
    let batch = make_batch(256);
    let encoded_len = batch.encoded_len();

    c.bench_function("proto_encode_256_heap", |b| {
        b.iter(|| {
            let mut buf = Vec::with_capacity(encoded_len);
            batch.encode(&mut buf).unwrap();
            black_box(buf);
        })
    });
}

fn bench_proto_encode_arena(c: &mut Criterion) {
    let batch = make_batch(256);
    let encoded_len = batch.encoded_len();
    let slot_size = encoded_len + 1024; // headroom

    let arena = FixedArena::with_slot_capacity(
        NonZeroUsize::new(8).unwrap(),
        NonZeroUsize::new(slot_size).unwrap(),
    )
    .auto_spill()
    .build()
    .unwrap();

    c.bench_function("proto_encode_256_arena", |b| {
        b.iter(|| {
            let mut buf = arena.allocate().unwrap();
            batch.encode(&mut buf).unwrap();
            let bytes = buf.freeze();
            black_box(bytes);
        })
    });
}

fn bench_batch_build(c: &mut Criterion) {
    c.bench_function("batch_build_256", |b| {
        b.iter(|| {
            black_box(make_batch(256));
        })
    });
}

fn bench_json_serialize(c: &mut Criterion) {
    // Compare: what pino/winston do (JSON.stringify equivalent)
    let event = serde_json::json!({
        "level": "info",
        "time": "2026-04-06T12:00:00.000Z",
        "msg": "benchmark event",
        "service": "bench-svc",
        "traceId": "trace-001",
        "sessionId": "sess-001",
        "userId": "user-001",
        "method": "POST",
        "path": "/agents/list",
        "status": 200,
        "durationMs": 42,
    });

    c.bench_function("json_serialize_single", |b| {
        b.iter(|| {
            let s = serde_json::to_vec(&event).unwrap();
            black_box(s);
        })
    });
}

fn bench_proto_encode_single(c: &mut Criterion) {
    let event = make_event(1);

    c.bench_function("proto_encode_single", |b| {
        b.iter(|| {
            let mut buf = Vec::with_capacity(event.encoded_len());
            event.encode(&mut buf).unwrap();
            black_box(buf);
        })
    });
}

criterion_group!(
    benches,
    bench_event_creation,
    bench_json_serialize,
    bench_proto_encode_single,
    bench_proto_encode_heap,
    bench_proto_encode_arena,
    bench_batch_build,
);
criterion_main!(benches);
