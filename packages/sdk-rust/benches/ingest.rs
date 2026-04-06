use criterion::{criterion_group, criterion_main, Criterion};

fn bench_event_creation(c: &mut Criterion) {
    // TODO: bench event builder throughput
    c.bench_function("event_create", |b| {
        b.iter(|| {
            // placeholder
            std::hint::black_box(42)
        })
    });
}

criterion_group!(benches, bench_event_creation);
criterion_main!(benches);
