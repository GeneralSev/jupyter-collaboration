# Copyright (c) Jupyter Development Team.
# Distributed under the terms of the Modified BSD License.

from pycrdt.store import SQLiteYStore as _SQLiteYStore
from pycrdt.store import TempFileYStore as _TempFileYStore
from pycrdt.store.sqlite import connect, exception_logger, get_new_path
import anyio
import warnings
from traitlets import Int, Unicode
from traitlets.config import LoggingConfigurable


class TempFileYStoreMetaclass(type(LoggingConfigurable), type(_TempFileYStore)):  # type: ignore
    pass


class TempFileYStore(LoggingConfigurable, _TempFileYStore, metaclass=TempFileYStoreMetaclass):
    prefix_dir = "jupyter_ystore_"


class SQLiteYStoreMetaclass(type(LoggingConfigurable), type(_SQLiteYStore)):  # type: ignore
    pass


class SQLiteYStore(LoggingConfigurable, _SQLiteYStore, metaclass=SQLiteYStoreMetaclass):
    db_path = Unicode(
        ".jupyter_ystore.db",
        config=True,
        help="""The path to the YStore database. Defaults to '.jupyter_ystore.db' in the current
        directory.""",
    )

    squash_after_inactivity_of = Int(
        None,
        allow_none=True,
        config=True,
        help="""The document time-to-live in seconds. Defaults to None (document history is never
        cleared).""",
    )
    document_ttl = Int(
        None,
        allow_none=True,
        config=True,
        help="""The document time-to-live in seconds. Deprecated in favor of 'squash_after_inactivity_of'.
        Defaults to None (document history is never cleared).""",
    )

    async def _init_db(self):
        """Taken from https://github.com/y-crdt/pycrdt-store/blob/main/src/pycrdt/store/sqlite.py#L273

        Changed:
        SQL command: `CREATE TABLE` to `CREATE TABLE IF NOT EXISTS` for `yupdates` and `ycheckpoints` tables
        """
        if self.squash_after_inactivity_of is None and self.document_ttl is not None:
            warnings.warn(
                "`document_ttl` is deprecated. Use `squash_after_inactivity_of` instead.",
                DeprecationWarning,
                stacklevel=2,
            )
            self.squash_after_inactivity_of = self.document_ttl
        create_db = False
        move_db = False
        if not await anyio.Path(self.db_path).exists():
            create_db = True
        else:
            async with self.lock:
                db = await connect(
                    self.db_path,
                    exception_handler=exception_logger,
                    log=self.log,
                )
                async with db:
                    cursor = await db.cursor()
                    await cursor.execute(
                        "SELECT count(name) FROM sqlite_master "
                        "WHERE type='table' and name='yupdates'"
                    )
                    table_exists = (await cursor.fetchone())[0]
                    if table_exists:
                        await cursor.execute("pragma user_version")
                        version = (await cursor.fetchone())[0]
                        if version != self.version:
                            move_db = True
                            create_db = True
                        else:
                            # if ycheckpoints is missing, we need a fresh schema
                            await cursor.execute(
                                "SELECT count(name) FROM sqlite_master "
                                "WHERE type='table' AND name='ycheckpoints'"
                            )
                            ckpt_exists = (await cursor.fetchone())[0]
                            if not ckpt_exists:
                                create_db = True
                    else:
                        create_db = True
                await db.close()
        if move_db:
            new_path = await get_new_path(self.db_path)
            self.log.warning("YStore version mismatch, moving %s to %s", self.db_path, new_path)
            await anyio.Path(self.db_path).rename(new_path)
        if create_db:
            async with self.lock:
                db = await connect(
                    self.db_path,
                    exception_handler=exception_logger,
                    log=self.log,
                )
                async with db:
                    cursor = await db.cursor()
                    # enable full auto-vacuum & rebuild now
                    await cursor.execute("PRAGMA auto_vacuum = FULL")
                    await cursor.execute("VACUUM")
                    await cursor.execute(
                        "CREATE TABLE IF NOT EXISTS yupdates (path TEXT NOT NULL, yupdate BLOB, "
                        "metadata BLOB, timestamp REAL NOT NULL)"
                    )
                    await cursor.execute(
                        "CREATE INDEX IF NOT EXISTS idx_yupdates_path_timestamp ON yupdates (path, timestamp)"
                    )
                    # checkpoint table
                    await cursor.execute(
                        "CREATE TABLE IF NOT EXISTS ycheckpoints ("
                        "path TEXT NOT NULL, "
                        "checkpoint BLOB NOT NULL, "
                        "timestamp REAL NOT NULL, "
                        "PRIMARY KEY(path)"
                        ")"
                    )
                    await cursor.execute(f"PRAGMA user_version = {self.version}")
                self._db = db
        else:
            self._db = await connect(
                self.db_path,
                exception_handler=exception_logger,
                log=self.log,
            )
        assert self.db_initialized is not None
        self.db_initialized.set()
