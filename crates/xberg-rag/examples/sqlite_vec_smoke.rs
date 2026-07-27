//! Entity-graph plan, Step 0 spike: proves `rusqlite` + `sqlite-vec` load
//! together in a genuinely **in-memory** connection (no file ever touches
//! disk — this is the shape `graph_query`'s ephemeral decrypt-query-discard
//! design needs), and that a `vec0` virtual table + KNN query actually works.
//!
//! Run with: `cargo run -p xberg-rag --example sqlite_vec_smoke --features sqlite-vec-store`
//!
//! This is a throwaway proof, not production code — nothing here is wired
//! into `RagEngine`/`FlatStore`.

#[allow(unsafe_code)]
fn main() -> rusqlite::Result<()> {
    // SAFETY: sqlite3_auto_extension registers sqlite-vec's real init entry point (whose true C ABI
    // takes db/pzErrMsg/pApi, even though this crate's own extern "C" binding declares it as
    // zero-arg) globally, before any connection is opened — the exact pattern sqlite-vec's own
    // upstream test uses. Must run exactly once, before `Connection::open_in_memory()` below.
    unsafe {
        rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute::<
            *const (),
            unsafe extern "C" fn(
                *mut rusqlite::ffi::sqlite3,
                *mut *mut std::os::raw::c_char,
                *const rusqlite::ffi::sqlite3_api_routines,
            ) -> std::os::raw::c_int,
        >(sqlite_vec::sqlite3_vec_init as *const ())));
    }

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
        "insert into vec_entities (entity_id, matter_id, embedding) values (2, 'matter-a', '[0.0, 1.0, 0.0, 0.0]')",
        [],
    )?;
    db.execute(
        "insert into vec_entities (entity_id, matter_id, embedding) values (3, 'matter-b', '[1.0, 0.1, 0.0, 0.0]')",
        [],
    )?;

    let mut stmt = db.prepare(
        "select entity_id, distance from vec_entities
         where matter_id = 'matter-a' and embedding match '[1.0, 0.0, 0.0, 0.0]'
         order by distance limit 5",
    )?;
    let rows = stmt.query_map([], |row| {
        let id: i64 = row.get(0)?;
        let distance: f64 = row.get(1)?;
        Ok((id, distance))
    })?;

    println!("KNN results (partitioned to matter-a, so entity 3 in matter-b must not appear):");
    for row in rows {
        let (id, distance) = row?;
        println!("  entity_id={id} distance={distance:.4}");
    }

    Ok(())
}
