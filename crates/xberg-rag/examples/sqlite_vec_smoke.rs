//! Entity-graph plan, Step 0 spike: proves `rusqlite` + `sqlite-vec` load
//! together in a genuinely **in-memory** connection (no file ever touches
//! disk — this is the shape `graph_query`'s ephemeral decrypt-query-discard
//! design needs), and that a `vec0` virtual table + KNN query actually works.
//!
//! Run with: `cargo run -p xberg-rag --example sqlite_vec_smoke --features sqlite-vec-store`
//!
//! This is a throwaway proof, not production code — nothing here is wired
//! into `RagEngine`/`FlatStore`.

/// True C ABI of a SQLite extension's init entry point (db, pzErrMsg, pApi) -> status. Named so the
/// `transmute` below has an explicit, auditable target type instead of an inline turbofish.
type SqliteExtensionInit = unsafe extern "C" fn(
    *mut rusqlite::ffi::sqlite3,
    *mut *mut std::os::raw::c_char,
    *const rusqlite::ffi::sqlite3_api_routines,
) -> std::os::raw::c_int;

#[allow(unsafe_code)]
fn main() -> rusqlite::Result<()> {
    // SAFETY: sqlite3_auto_extension registers sqlite-vec's real init entry point (whose true C ABI
    // is SqliteExtensionInit, even though this crate's own extern "C" binding declares it as
    // zero-arg) globally, before any connection is opened — the exact pattern sqlite-vec's own
    // upstream test uses. Must run exactly once, before `Connection::open_in_memory()` below.
    let rc = unsafe {
        let init: SqliteExtensionInit = std::mem::transmute(sqlite_vec::sqlite3_vec_init as *const ());
        rusqlite::ffi::sqlite3_auto_extension(Some(init))
    };
    assert_eq!(
        rc, 0,
        "sqlite3_auto_extension failed to register sqlite-vec (code {rc})"
    );

    let db = rusqlite::Connection::open_in_memory()?;

    let version: String = db.query_row("select vec_version()", [], |row| row.get(0))?;
    println!("sqlite-vec version: {version}");

    db.execute_batch(
        "create virtual table vec_entities using vec0(
            entity_id integer primary key,
            matter_id text partition key,
            embedding float[4]
        );",
    )?;

    db.execute(
        "insert into vec_entities (entity_id, matter_id, embedding) values (1, 'matter-a', '[1.0, 0.0, 0.0, 0.0]')",
        [],
    )?;
    db.execute(
        "insert into vec_entities (entity_id, matter_id, embedding) values (2, 'matter-a', '[0.9, 0.1, 0.0, 0.0]')",
        [],
    )?;
    // Several matter-b vectors, all placed *closer* to the query than either matter-a vector. If
    // partition filtering only happened after top-k selection (rather than pruning matter-b out
    // before/alongside it), these would crowd matter-a's own rows out of a `k`-limited result
    // entirely — a real correctness bug (a lawyer's own matter starved out by another matter's
    // data), not just a performance concern. `k = 2` (sqlite-vec's own KNN limit, not a plain SQL
    // LIMIT) forces that interaction to actually be exercised.
    for (id, vector) in [
        (3, "[1.0, 0.01, 0.0, 0.0]"),
        (4, "[1.0, 0.02, 0.0, 0.0]"),
        (5, "[1.0, 0.03, 0.0, 0.0]"),
    ] {
        db.execute(
            "insert into vec_entities (entity_id, matter_id, embedding) values (?1, 'matter-b', ?2)",
            rusqlite::params![id, vector],
        )?;
    }

    let mut stmt = db.prepare(
        "select entity_id, distance from vec_entities
         where matter_id = 'matter-a' and embedding match '[1.0, 0.0, 0.0, 0.0]' and k = 2
         order by distance",
    )?;
    let rows = stmt.query_map([], |row| {
        let id: i64 = row.get(0)?;
        let distance: f64 = row.get(1)?;
        Ok((id, distance))
    })?;
    let results = rows.collect::<rusqlite::Result<Vec<_>>>()?;

    // The real assertion this whole spike exists to make: partitioning by matter_id must exclude
    // every matter-b entity from a matter-a query even though entities 3-5 (matter-b) are all
    // geometrically closer to the query than matter-a's own entity 2 — not just "usually excluded
    // when nothing competes for the k-limit", but excluded even under real cross-tenant contention.
    assert_eq!(
        results.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
        vec![1, 2],
        "KNN query must exclude vectors from other partitions, even ones closer than the matter's own"
    );

    println!(
        "KNN results (partitioned to matter-a; entities 3-5 in matter-b, despite being closer, correctly excluded):"
    );
    for (id, distance) in results {
        println!("  entity_id={id} distance={distance:.4}");
    }

    Ok(())
}
