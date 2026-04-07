use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::HashMap;
use std::sync::OnceLock;

use aires_sdk::Aires;

static INSTANCE: OnceLock<Aires> = OnceLock::new();

#[napi(object)]
pub struct InitOptions {
    pub service: String,
    pub endpoint: String,
    pub environment: Option<String>,
    pub batch_size: Option<u32>,
    pub queue_capacity: Option<u32>,
    pub tls: Option<bool>,
    pub api_key: Option<String>,
}

#[napi]
pub fn init(opts: InitOptions) -> Result<()> {
    let mut builder = Aires::builder()
        .service(opts.service)
        .endpoint(opts.endpoint);

    if let Some(env) = opts.environment {
        builder = builder.environment(env);
    }
    if let Some(bs) = opts.batch_size {
        builder = builder.batch_size(bs as usize);
    }
    if let Some(qc) = opts.queue_capacity {
        builder = builder.queue_capacity(qc as usize);
    }
    if let Some(tls) = opts.tls {
        builder = builder.tls(tls);
    }
    if let Some(key) = opts.api_key {
        builder = builder.api_key(key);
    }

    let config = builder
        .build()
        .map_err(|e| Error::from_reason(e.to_string()))?;

    let aires = Aires::from_config(config).map_err(|e| Error::from_reason(e.to_string()))?;

    INSTANCE
        .set(aires)
        .map_err(|_| Error::from_reason("aires already initialized"))?;

    Ok(())
}

fn get_instance() -> Result<&'static Aires> {
    INSTANCE
        .get()
        .ok_or_else(|| Error::from_reason("aires not initialized — call init() first"))
}

#[napi(object)]
pub struct LogOptions {
    pub trace_id: Option<String>,
    pub span_id: Option<String>,
    pub session_id: Option<String>,
    pub user_id: Option<String>,
    pub agent_id: Option<String>,
    pub category: Option<String>,
    pub kind: Option<String>,
    pub display_text: Option<String>,
    pub tags: Option<Vec<String>>,
    pub attributes: Option<HashMap<String, String>>,
    pub data: Option<HashMap<String, String>>,
    pub source_file: Option<String>,
    pub source_line: Option<i32>,
    pub source_function: Option<String>,
}

fn apply_opts(
    mut builder: aires_sdk::EventBuilder<'_>,
    opts: Option<LogOptions>,
) -> aires_sdk::EventBuilder<'_> {
    if let Some(o) = opts {
        if let Some(v) = o.trace_id {
            builder = builder.trace_id(v);
        }
        if let Some(v) = o.span_id {
            builder = builder.span_id(v);
        }
        if let Some(v) = o.session_id {
            builder = builder.session_id(v);
        }
        if let Some(v) = o.user_id {
            builder = builder.user_id(v);
        }
        if let Some(v) = o.agent_id {
            builder = builder.agent_id(v);
        }
        if let Some(v) = o.category {
            builder = builder.category(v);
        }
        if let Some(v) = o.kind {
            builder = builder.kind(v);
        }
        if let Some(v) = o.display_text {
            builder = builder.display_text(v);
        }
        if let Some(tags) = o.tags {
            for t in tags {
                builder = builder.tag(t);
            }
        }
        if let Some(attrs) = o.attributes {
            for (k, v) in attrs {
                builder = builder.attr(k, v);
            }
        }
        if let Some(data) = o.data {
            for (k, v) in data {
                builder = builder.data(k, v);
            }
        }
        if let Some(file) = o.source_file {
            builder = builder.source(
                &file,
                o.source_line.unwrap_or(0),
                o.source_function.as_deref().unwrap_or(""),
            );
        }
    }
    builder
}

#[napi]
pub fn trace(message: String, opts: Option<LogOptions>) -> Result<()> {
    let aires = get_instance()?;
    apply_opts(aires.trace(message), opts).emit();
    Ok(())
}

#[napi]
pub fn debug(message: String, opts: Option<LogOptions>) -> Result<()> {
    let aires = get_instance()?;
    apply_opts(aires.debug(message), opts).emit();
    Ok(())
}

#[napi]
pub fn info(message: String, opts: Option<LogOptions>) -> Result<()> {
    let aires = get_instance()?;
    apply_opts(aires.info(message), opts).emit();
    Ok(())
}

#[napi]
pub fn warn(message: String, opts: Option<LogOptions>) -> Result<()> {
    let aires = get_instance()?;
    apply_opts(aires.warn(message), opts).emit();
    Ok(())
}

#[napi]
pub fn error(message: String, opts: Option<LogOptions>) -> Result<()> {
    let aires = get_instance()?;
    apply_opts(aires.error(message), opts).emit();
    Ok(())
}

#[napi]
pub fn fatal(message: String, opts: Option<LogOptions>) -> Result<()> {
    let aires = get_instance()?;
    apply_opts(aires.fatal(message), opts).emit();
    Ok(())
}

#[napi]
pub fn span(name: String, opts: Option<LogOptions>) -> Result<()> {
    let aires = get_instance()?;
    apply_opts(aires.span(name), opts).emit();
    Ok(())
}

#[napi]
pub fn metric(name: String, value: f64, opts: Option<LogOptions>) -> Result<()> {
    let aires = get_instance()?;
    apply_opts(aires.metric(name, value), opts).emit();
    Ok(())
}

#[napi]
pub async fn flush() -> Result<()> {
    let aires = get_instance()?;
    aires.flush().await;
    Ok(())
}
