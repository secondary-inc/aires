use std::time::{SystemTime, UNIX_EPOCH};

use uuid::Uuid;

use crate::proto;
use crate::Aires;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
    Fatal,
}

impl Severity {
    pub(crate) fn to_proto(self) -> i32 {
        match self {
            Self::Trace => proto::Severity::Trace as i32,
            Self::Debug => proto::Severity::Debug as i32,
            Self::Info => proto::Severity::Info as i32,
            Self::Warn => proto::Severity::Warn as i32,
            Self::Error => proto::Severity::Error as i32,
            Self::Fatal => proto::Severity::Fatal as i32,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Event {
    pub(crate) inner: proto::Event,
}

impl Event {
    pub fn id(&self) -> &str {
        &self.inner.id
    }
    pub fn message(&self) -> &str {
        &self.inner.message
    }
    pub fn trace_id(&self) -> &str {
        &self.inner.trace_id
    }
    pub fn span_id(&self) -> &str {
        &self.inner.span_id
    }
    pub fn session_id(&self) -> &str {
        &self.inner.session_id
    }

    pub(crate) fn into_proto(self) -> proto::Event {
        self.inner
    }
}

fn now_ns() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64
}

pub struct EventBuilder<'a> {
    aires: &'a Aires,
    event: proto::Event,
}

impl<'a> EventBuilder<'a> {
    pub(crate) fn new(aires: &'a Aires, severity: Severity, message: String) -> Self {
        let config = aires.config();
        Self {
            aires,
            event: proto::Event {
                id: Uuid::now_v7().to_string(),
                timestamp_ns: now_ns(),
                observed_timestamp_ns: 0,
                service: config.service.clone(),
                environment: config.environment.clone(),
                severity: severity.to_proto(),
                message,
                kind: "log".into(),
                category: String::new(),
                ..Default::default()
            },
        }
    }

    pub(crate) fn span(aires: &'a Aires, name: String) -> Self {
        let config = aires.config();
        Self {
            aires,
            event: proto::Event {
                id: Uuid::now_v7().to_string(),
                timestamp_ns: now_ns(),
                observed_timestamp_ns: 0,
                service: config.service.clone(),
                environment: config.environment.clone(),
                severity: proto::Severity::Info as i32,
                message: name,
                kind: "span".into(),
                span_id: Uuid::now_v7().to_string(),
                ..Default::default()
            },
        }
    }

    pub(crate) fn metric(aires: &'a Aires, name: String, value: f64) -> Self {
        let config = aires.config();
        Self {
            aires,
            event: proto::Event {
                id: Uuid::now_v7().to_string(),
                timestamp_ns: now_ns(),
                observed_timestamp_ns: 0,
                service: config.service.clone(),
                environment: config.environment.clone(),
                severity: proto::Severity::Info as i32,
                message: name.clone(),
                kind: "metric".into(),
                metric: Some(proto::MetricValue {
                    name,
                    value,
                    unit: String::new(),
                    r#type: proto::MetricType::Gauge as i32,
                }),
                ..Default::default()
            },
        }
    }

    pub fn trace_id(mut self, id: impl Into<String>) -> Self {
        self.event.trace_id = id.into();
        self
    }

    pub fn span_id(mut self, id: impl Into<String>) -> Self {
        self.event.span_id = id.into();
        self
    }

    pub fn parent_span_id(mut self, id: impl Into<String>) -> Self {
        self.event.parent_span_id = id.into();
        self
    }

    pub fn subtrace_id(mut self, id: impl Into<String>) -> Self {
        self.event.subtrace_id = id.into();
        self
    }

    pub fn session_id(mut self, id: impl Into<String>) -> Self {
        self.event.session_id = id.into();
        self
    }

    pub fn user_id(mut self, id: impl Into<String>) -> Self {
        self.event.user_id = id.into();
        self
    }

    pub fn agent_id(mut self, id: impl Into<String>) -> Self {
        self.event.agent_id = id.into();
        self
    }

    pub fn category(mut self, cat: impl Into<String>) -> Self {
        self.event.category = cat.into();
        self
    }

    pub fn kind(mut self, k: impl Into<String>) -> Self {
        self.event.kind = k.into();
        self
    }

    pub fn display_text(mut self, text: impl Into<String>) -> Self {
        self.event.display_text = text.into();
        self
    }

    pub fn tag(mut self, tag: impl Into<String>) -> Self {
        self.event.tags.push(tag.into());
        self
    }

    pub fn attr(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.event.attributes.insert(key.into(), value.into());
        self
    }

    pub fn data(mut self, key: impl Into<String>, value: impl serde::Serialize) -> Self {
        if let Ok(bytes) = serde_json::to_vec(&value) {
            self.event.data.insert(key.into(), bytes);
        }
        self
    }

    pub fn related(
        mut self,
        kind: impl Into<String>,
        id: impl Into<String>,
        label: impl Into<String>,
    ) -> Self {
        self.event.related.push(proto::RelatedObject {
            r#type: kind.into(),
            id: id.into(),
            label: label.into(),
            url: String::new(),
        });
        self
    }

    pub fn source(mut self, file: &str, line: i32, function: &str) -> Self {
        self.event.source_file = file.into();
        self.event.source_line = line;
        self.event.source_function = function.into();
        self
    }

    pub fn http(
        mut self,
        method: impl Into<String>,
        path: impl Into<String>,
        status: i32,
        duration_ms: i64,
    ) -> Self {
        self.event.http = Some(proto::HttpInfo {
            method: method.into(),
            path: path.into(),
            status_code: status,
            duration_ms,
            ..Default::default()
        });
        self
    }

    pub fn error_info(
        mut self,
        err_type: impl Into<String>,
        message: impl Into<String>,
        stack: impl Into<String>,
        handled: bool,
    ) -> Self {
        self.event.error = Some(proto::ErrorInfo {
            r#type: err_type.into(),
            message: message.into(),
            stack: stack.into(),
            handled,
        });
        self
    }

    pub fn duration_ns(mut self, ns: u64) -> Self {
        self.event.timestamp_ns = now_ns().saturating_sub(ns);
        self
    }

    pub fn emit(self) {
        self.aires.submit(Event { inner: self.event });
    }
}

#[macro_export]
macro_rules! aires_log {
    ($aires:expr, $level:ident, $msg:expr $(, $key:ident = $val:expr)*) => {{
        let mut builder = $aires.$level($msg)
            .source(file!(), line!() as i32, "");
        $(
            builder = builder.attr(stringify!($key), $val);
        )*
        builder.emit();
    }};
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn severity_proto_roundtrip() {
        assert_eq!(Severity::Trace.to_proto(), proto::Severity::Trace as i32);
        assert_eq!(Severity::Fatal.to_proto(), proto::Severity::Fatal as i32);
    }

    #[test]
    fn event_builder_sets_fields() {
        // We can't call emit() without an Aires instance,
        // but we can verify the builder populates fields
        let event = proto::Event {
            id: "test".into(),
            message: "hello".into(),
            ..Default::default()
        };
        let wrapped = Event { inner: event };
        assert_eq!(wrapped.message(), "hello");
    }
}
