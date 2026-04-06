use pyo3::prelude::*;
use pyo3::types::PyDict;
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::Instant;

use aires_sdk::{Aires, Severity};

static INSTANCE: OnceLock<Aires> = OnceLock::new();

fn get_instance() -> PyResult<&'static Aires> {
    INSTANCE.get().ok_or_else(|| {
        PyErr::new::<pyo3::exceptions::PyRuntimeError, _>(
            "aires not initialized — call aires.init() first",
        )
    })
}

// Promoted keys that get dedicated proto fields (indexed in ClickHouse)
const PROMOTED: &[&str] = &[
    "trace_id",
    "span_id",
    "parent_span_id",
    "subtrace_id",
    "session_id",
    "user_id",
];

fn emit_event(
    severity: Severity,
    message: &str,
    base_attrs: &HashMap<String, String>,
    extra: Option<&Bound<'_, PyDict>>,
) -> PyResult<()> {
    let aires = get_instance()?;
    let mut builder = aires.log(severity, message);

    // Apply base attrs (from .with_())
    for (k, v) in base_attrs {
        if PROMOTED.contains(&k.as_str()) {
            match k.as_str() {
                "trace_id" => builder = builder.trace_id(v),
                "span_id" => builder = builder.span_id(v),
                "session_id" => builder = builder.session_id(v),
                "user_id" => builder = builder.user_id(v),
                "subtrace_id" => builder = builder.subtrace_id(v),
                _ => builder = builder.attr(k, v),
            }
        } else {
            builder = builder.attr(k, v);
        }
    }

    // Apply extra kwargs
    if let Some(dict) = extra {
        for (k, v) in dict.iter() {
            let key: String = k.extract()?;
            let val: String = if let Ok(s) = v.extract::<String>() {
                s
            } else if let Ok(i) = v.extract::<i64>() {
                i.to_string()
            } else if let Ok(f) = v.extract::<f64>() {
                f.to_string()
            } else if let Ok(b) = v.extract::<bool>() {
                b.to_string()
            } else {
                v.str()?.to_string()
            };

            if PROMOTED.contains(&key.as_str()) {
                match key.as_str() {
                    "trace_id" => builder = builder.trace_id(val),
                    "span_id" => builder = builder.span_id(val),
                    "session_id" => builder = builder.session_id(val),
                    "user_id" => builder = builder.user_id(val),
                    "subtrace_id" => builder = builder.subtrace_id(val),
                    _ => builder = builder.attr(key, val),
                }
            } else {
                builder = builder.attr(key, val);
            }
        }
    }

    builder.emit();
    Ok(())
}

// ── Logger class ────────────────────────────────────────────────────────────

#[pyclass]
#[derive(Clone)]
struct Logger {
    base: Arc<HashMap<String, String>>,
}

#[pymethods]
impl Logger {
    #[pyo3(signature = (message, **kwargs))]
    fn __call__(&self, message: &str, kwargs: Option<&Bound<'_, PyDict>>) -> PyResult<()> {
        emit_event(Severity::Info, message, &self.base, kwargs)
    }

    #[pyo3(signature = (message, **kwargs))]
    fn trace(&self, message: &str, kwargs: Option<&Bound<'_, PyDict>>) -> PyResult<()> {
        emit_event(Severity::Trace, message, &self.base, kwargs)
    }

    #[pyo3(signature = (message, **kwargs))]
    fn debug(&self, message: &str, kwargs: Option<&Bound<'_, PyDict>>) -> PyResult<()> {
        emit_event(Severity::Debug, message, &self.base, kwargs)
    }

    #[pyo3(signature = (message, **kwargs))]
    fn info(&self, message: &str, kwargs: Option<&Bound<'_, PyDict>>) -> PyResult<()> {
        emit_event(Severity::Info, message, &self.base, kwargs)
    }

    #[pyo3(signature = (message, **kwargs))]
    fn warn(&self, message: &str, kwargs: Option<&Bound<'_, PyDict>>) -> PyResult<()> {
        emit_event(Severity::Warn, message, &self.base, kwargs)
    }

    #[pyo3(signature = (message, **kwargs))]
    fn error(&self, message: &str, kwargs: Option<&Bound<'_, PyDict>>) -> PyResult<()> {
        emit_event(Severity::Error, message, &self.base, kwargs)
    }

    #[pyo3(signature = (message, **kwargs))]
    fn fatal(&self, message: &str, kwargs: Option<&Bound<'_, PyDict>>) -> PyResult<()> {
        emit_event(Severity::Fatal, message, &self.base, kwargs)
    }

    #[pyo3(signature = (**kwargs))]
    fn with_(&self, kwargs: Option<&Bound<'_, PyDict>>) -> PyResult<Logger> {
        let mut merged = (*self.base).clone();
        if let Some(dict) = kwargs {
            for (k, v) in dict.iter() {
                let key: String = k.extract()?;
                let val: String = if let Ok(s) = v.extract::<String>() {
                    s
                } else {
                    v.str()?.to_string()
                };
                merged.insert(key, val);
            }
        }
        Ok(Logger {
            base: Arc::new(merged),
        })
    }

    #[pyo3(signature = (name, **kwargs))]
    fn span(&self, name: &str, kwargs: Option<&Bound<'_, PyDict>>) -> PyResult<Span> {
        let span_id = uuid::Uuid::now_v7().to_string();
        let mut span_attrs = (*self.base).clone();
        span_attrs.insert("span_id".into(), span_id.clone());
        if let Some(dict) = kwargs {
            for (k, v) in dict.iter() {
                let key: String = k.extract()?;
                let val: String = if let Ok(s) = v.extract::<String>() {
                    s
                } else {
                    v.str()?.to_string()
                };
                span_attrs.insert(key, val);
            }
        }

        emit_event(
            Severity::Info,
            &format!("span:start {name}"),
            &span_attrs,
            None,
        )?;

        Ok(Span {
            name: name.to_string(),
            attrs: Arc::new(span_attrs),
            start: Instant::now(),
        })
    }

    #[pyo3(signature = (name, value, **kwargs))]
    fn metric(&self, name: &str, value: f64, kwargs: Option<&Bound<'_, PyDict>>) -> PyResult<()> {
        let aires = get_instance()?;
        let mut builder = aires.metric(name, value);
        for (k, v) in self.base.iter() {
            builder = builder.attr(k, v);
        }
        if let Some(dict) = kwargs {
            for (k, v) in dict.iter() {
                let key: String = k.extract()?;
                let val: String = if let Ok(s) = v.extract::<String>() {
                    s
                } else {
                    v.str()?.to_string()
                };
                builder = builder.attr(key, val);
            }
        }
        builder.emit();
        Ok(())
    }
}

// ── Span (context manager) ──────────────────────────────────────────────────

#[pyclass]
struct Span {
    name: String,
    attrs: Arc<HashMap<String, String>>,
    start: Instant,
}

#[pymethods]
impl Span {
    fn __enter__(slf: Py<Self>) -> Py<Self> {
        slf
    }

    fn __exit__(
        &self,
        _exc_type: Option<&Bound<'_, pyo3::types::PyAny>>,
        _exc_val: Option<&Bound<'_, pyo3::types::PyAny>>,
        _exc_tb: Option<&Bound<'_, pyo3::types::PyAny>>,
    ) -> PyResult<bool> {
        self.end()?;
        Ok(false) // don't suppress exceptions
    }

    fn end(&self) -> PyResult<()> {
        let duration_ms = self.start.elapsed().as_millis() as u64;
        let mut attrs = (*self.attrs).clone();
        attrs.insert("_span".into(), "end".into());
        attrs.insert("_span_name".into(), self.name.clone());
        attrs.insert("duration_ms".into(), duration_ms.to_string());
        emit_event(
            Severity::Info,
            &format!("span:end {}", self.name),
            &attrs,
            None,
        )
    }

    #[pyo3(signature = (message, **kwargs))]
    fn log(&self, message: &str, kwargs: Option<&Bound<'_, PyDict>>) -> PyResult<()> {
        emit_event(Severity::Info, message, &self.attrs, kwargs)
    }
}

// ── Module init ─────────────────────────────────────────────────────────────

#[pyfunction]
#[pyo3(signature = (service, endpoint, environment=None, batch_size=None, queue_capacity=None, tls=None, api_key=None))]
fn init(
    service: String,
    endpoint: String,
    environment: Option<String>,
    batch_size: Option<usize>,
    queue_capacity: Option<usize>,
    tls: Option<bool>,
    api_key: Option<String>,
) -> PyResult<()> {
    let mut builder = Aires::builder().service(service).endpoint(endpoint);

    if let Some(env) = environment {
        builder = builder.environment(env);
    }
    if let Some(bs) = batch_size {
        builder = builder.batch_size(bs);
    }
    if let Some(qc) = queue_capacity {
        builder = builder.queue_capacity(qc);
    }
    if let Some(t) = tls {
        builder = builder.tls(t);
    }
    if let Some(k) = api_key {
        builder = builder.api_key(k);
    }

    let config = builder
        .build()
        .map_err(|e| PyErr::new::<pyo3::exceptions::PyValueError, _>(e.to_string()))?;

    let inst = Aires::from_config(config)
        .map_err(|e| PyErr::new::<pyo3::exceptions::PyRuntimeError, _>(e.to_string()))?;

    INSTANCE
        .set(inst)
        .map_err(|_| PyErr::new::<pyo3::exceptions::PyRuntimeError, _>("already initialized"))?;

    Ok(())
}

#[pyfunction]
fn patch_logging(py: Python<'_>) -> PyResult<()> {
    py.run(
        c"import logging

class AiresHandler(logging.Handler):
    def __init__(self):
        super().__init__()
        import aires as _aires
        self._log = _aires.log

    def emit(self, record):
        try:
            msg = self.format(record)
            level = record.levelno
            if level >= 50:
                self._log.fatal(msg)
            elif level >= 40:
                self._log.error(msg)
            elif level >= 30:
                self._log.warn(msg)
            elif level >= 20:
                self._log.info(msg)
            elif level >= 10:
                self._log.debug(msg)
            else:
                self._log.trace(msg)
        except Exception:
            self.handleError(record)

logging.root.addHandler(AiresHandler())
",
        None,
        None,
    )?;
    Ok(())
}

#[pymodule]
fn aires(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(init, m)?)?;
    m.add_function(wrap_pyfunction!(patch_logging, m)?)?;
    m.add_class::<Logger>()?;
    m.add_class::<Span>()?;

    // Create the global `log` instance
    let log = Logger {
        base: Arc::new(HashMap::new()),
    };
    m.add("log", log)?;

    Ok(())
}
