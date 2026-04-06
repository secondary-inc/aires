use pyo3::prelude::*;
use std::collections::HashMap;
use std::sync::OnceLock;

use aires_sdk::{Aires, Severity};

static INSTANCE: OnceLock<Aires> = OnceLock::new();

fn get_instance() -> PyResult<&'static Aires> {
    INSTANCE.get().ok_or_else(|| {
        PyErr::new::<pyo3::exceptions::PyRuntimeError, _>(
            "aires not initialized — call init() first",
        )
    })
}

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

    let aires = Aires::from_config(config)
        .map_err(|e| PyErr::new::<pyo3::exceptions::PyRuntimeError, _>(e.to_string()))?;

    INSTANCE.set(aires).map_err(|_| {
        PyErr::new::<pyo3::exceptions::PyRuntimeError, _>("aires already initialized")
    })?;

    Ok(())
}

fn emit(
    severity: Severity,
    message: String,
    kwargs: Option<HashMap<String, String>>,
) -> PyResult<()> {
    let aires = get_instance()?;
    let mut builder = aires.log(severity, message);

    if let Some(kw) = kwargs {
        for (k, v) in kw {
            match k.as_str() {
                "trace_id" => {
                    builder = builder.trace_id(v);
                }
                "span_id" => {
                    builder = builder.span_id(v);
                }
                "session_id" => {
                    builder = builder.session_id(v);
                }
                "user_id" => {
                    builder = builder.user_id(v);
                }
                "agent_id" => {
                    builder = builder.agent_id(v);
                }
                "category" => {
                    builder = builder.category(v);
                }
                _ => {
                    builder = builder.attr(k, v);
                }
            }
        }
    }

    builder.emit();
    Ok(())
}

#[pyfunction]
#[pyo3(signature = (message, **kwargs))]
fn trace(message: String, kwargs: Option<HashMap<String, String>>) -> PyResult<()> {
    emit(Severity::Trace, message, kwargs)
}

#[pyfunction]
#[pyo3(signature = (message, **kwargs))]
fn debug(message: String, kwargs: Option<HashMap<String, String>>) -> PyResult<()> {
    emit(Severity::Debug, message, kwargs)
}

#[pyfunction]
#[pyo3(signature = (message, **kwargs))]
fn info(message: String, kwargs: Option<HashMap<String, String>>) -> PyResult<()> {
    emit(Severity::Info, message, kwargs)
}

#[pyfunction]
#[pyo3(signature = (message, **kwargs))]
fn warn(message: String, kwargs: Option<HashMap<String, String>>) -> PyResult<()> {
    emit(Severity::Warn, message, kwargs)
}

#[pyfunction]
#[pyo3(signature = (message, **kwargs))]
fn error(message: String, kwargs: Option<HashMap<String, String>>) -> PyResult<()> {
    emit(Severity::Error, message, kwargs)
}

#[pyfunction]
#[pyo3(signature = (message, **kwargs))]
fn fatal(message: String, kwargs: Option<HashMap<String, String>>) -> PyResult<()> {
    emit(Severity::Fatal, message, kwargs)
}

#[pyfunction]
#[pyo3(signature = (name, value, **kwargs))]
fn metric(name: String, value: f64, kwargs: Option<HashMap<String, String>>) -> PyResult<()> {
    let aires = get_instance()?;
    let mut builder = aires.metric(name, value);
    if let Some(kw) = kwargs {
        for (k, v) in kw {
            builder = builder.attr(k, v);
        }
    }
    builder.emit();
    Ok(())
}

#[pymodule]
fn aires(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(init, m)?)?;
    m.add_function(wrap_pyfunction!(trace, m)?)?;
    m.add_function(wrap_pyfunction!(debug, m)?)?;
    m.add_function(wrap_pyfunction!(info, m)?)?;
    m.add_function(wrap_pyfunction!(warn, m)?)?;
    m.add_function(wrap_pyfunction!(error, m)?)?;
    m.add_function(wrap_pyfunction!(fatal, m)?)?;
    m.add_function(wrap_pyfunction!(metric, m)?)?;
    Ok(())
}
