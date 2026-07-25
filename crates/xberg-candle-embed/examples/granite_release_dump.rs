use std::{env, fs::File, io::BufReader, path::PathBuf};

use serde::{Deserialize, Serialize};
use xberg_candle_embed::{EmbedderIdentity, GraniteEmbedder};

#[derive(Debug, Deserialize)]
struct CorpusFixture {
    query: String,
    documents: Vec<CorpusDocument>,
}

#[derive(Debug, Deserialize)]
struct CorpusDocument {
    id: String,
    language: String,
    text: String,
}

#[derive(Debug, Serialize)]
struct NativeVectorReport {
    id: String,
    language: String,
    vector: Vec<f32>,
}

#[derive(Debug, Serialize)]
struct NativeReport {
    identity: String,
    identity_fields: EmbedderIdentity,
    dimension: usize,
    query: NativeQueryReport,
    documents: Vec<NativeVectorReport>,
}

#[derive(Debug, Serialize)]
struct NativeQueryReport {
    text: String,
    vector: Vec<f32>,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args_os().skip(1);
    let corpus_path = PathBuf::from(
        args.next()
            .ok_or("usage: granite_release_dump <corpus.json> <model_dir>")?,
    );
    let model_dir = PathBuf::from(
        args.next()
            .ok_or("usage: granite_release_dump <corpus.json> <model_dir>")?,
    );

    let file = File::open(&corpus_path)?;
    let fixture: CorpusFixture = serde_json::from_reader(BufReader::new(file))?;
    let embedder = GraniteEmbedder::from_files(
        model_dir.join("model.safetensors"),
        model_dir.join("tokenizer.json"),
        model_dir.join("config.json"),
    )?;
    let document_texts: Vec<String> = fixture.documents.iter().map(|document| document.text.clone()).collect();
    let document_vectors = embedder.embed_documents(&document_texts)?;
    let query_vector = embedder.embed_query(&fixture.query)?;
    let identity = embedder.identity().clone();

    let report = NativeReport {
        identity: format!(
            "{}@{};{}->{};modernbert-{};{};normalize={}",
            identity.model,
            identity.revision,
            identity.source_dtype,
            identity.runtime_dtype,
            identity.dimension,
            identity.pooling,
            identity.normalize
        ),
        dimension: embedder.dimension(),
        identity_fields: identity,
        query: NativeQueryReport {
            text: fixture.query,
            vector: query_vector,
        },
        documents: fixture
            .documents
            .into_iter()
            .zip(document_vectors)
            .map(|(document, vector)| NativeVectorReport {
                id: document.id,
                language: document.language,
                vector,
            })
            .collect(),
    };

    serde_json::to_writer_pretty(std::io::stdout(), &report)?;
    Ok(())
}
