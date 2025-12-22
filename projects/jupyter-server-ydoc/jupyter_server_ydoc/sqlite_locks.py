from __future__ import annotations

import asyncio
import os
import sqlite3
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Tuple


@dataclass
class LockInfo:
    lock_key: str
    owner: str
    acquired_at: float
    heartbeat_at: float
    connections: int


class SQLiteDocumentLockManager:
    def __init__(
            self,
            db_path: str | Path,
            *,
            ttl_seconds: float = 120,
            busy_timeout_ms: int = 5000,
    ) -> None:
        """
        Cross-process exclusive locks stored in SQLite. Safe for multiple processes if they all point to the same DB
        file on a filesystem that supports file locks.

        Parameters:
        db_path: str
            The file path to the database.
        ttl_seconds: float, optional
            The time-to-live (TTL) for each lock before it expires without a heartbeat.
        busy_timeout_ms: int, optional
            The time, in milliseconds, for which the database access can block if it is busy. Default is 5000.
        """
        self.db_path = Path(db_path)
        self.ttl_seconds = ttl_seconds
        self.busy_timeout_ms = busy_timeout_ms

        # NOTE:
        # This will not work on Jupyter VM because this python process will not have read-write access to /srv
        # The directory and db file will have to be created manually with the correct permissions. E.g.:
        #
        #   sudo mkdir -p 666 /srv/collaboration
        #   sudo touch /srv/collaboration/collaboration_locks.db
        #   sudo chmod 666 /srv/collaboration/collaboration_locks.db
        #   sudo chown root:root /srv/collaboration/collaboration_locks.db
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    # ---------- public async API ----------

    async def try_acquire(self, lock_key: str, owner: str) -> Tuple[bool, Optional[LockInfo]]:
        return await asyncio.to_thread(self._try_acquire_sync, lock_key, owner)

    async def release(self, lock_key: str, owner: str) -> bool:
        return await asyncio.to_thread(self._release_sync, lock_key, owner)

    async def heartbeat(self, lock_key: str, owner: str) -> bool:
        return await asyncio.to_thread(self._heartbeat_sync, lock_key, owner)

    async def get(self, lock_key: str) -> Optional[LockInfo]:
        return await asyncio.to_thread(self._get_sync, lock_key)

    # ---------- internal sync implementation ----------

    def _connect(self) -> sqlite3.Connection:
        # check_same_thread=False allows using connection in background threads if needed,
        # but here we create a fresh connection per call anyway.
        con = sqlite3.connect(self.db_path, timeout=self.busy_timeout_ms / 1000.0)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA journal_mode=WAL;")
        con.execute("PRAGMA synchronous=NORMAL;")
        con.execute(f"PRAGMA busy_timeout={self.busy_timeout_ms};")
        return con

    def _init_db(self) -> None:
        con = self._connect()

        try:
            con.execute(
                """
                CREATE TABLE IF NOT EXISTS doc_locks
                (
                    lock_key
                    TEXT
                    PRIMARY
                    KEY,
                    owner
                    TEXT
                    NOT
                    NULL,
                    acquired_at
                    REAL
                    NOT
                    NULL,
                    heartbeat_at
                    REAL
                    NOT
                    NULL,
                    connections
                    INTEGER
                    NOT
                    NULL
                );
                """
            )
            con.execute("CREATE INDEX IF NOT EXISTS idx_doc_locks_owner ON doc_locks(owner);")
            con.commit()
        finally:
            con.close()

    def _is_expired(self, heartbeat_at: float) -> bool:
        """
        Determines if the given heartbeat timestamp is considered expired based on the time-to-live (TTL) threshold.

        Parameters:
        heartbeat_at (float): The timestamp of the last heartbeat in seconds since epoch.

        Returns:
        bool: True if the heartbeat is expired, False otherwise.
        """
        return (time.time() - heartbeat_at) > self.ttl_seconds

    def _try_acquire_sync(self, lock_key: str, owner: str) -> Tuple[bool, Optional[LockInfo]]:
        """
        Attempts to acquire a lock for a given lock_key (based on file) and owner.

        The function ensures synchronization by using a database-based locking mechanism to prevent concurrent
        operations on the same key. It handles the following cases:
        --> key is not yet locked
        --> the lock is expired
        --> the lock is held by the same owner.

        Parameters:
            lock_key: str
                The unique key identifying the lock to be acquired. This is based on the file path.
            owner: str
                The identifier of the entity attempting to acquire the lock.

        Returns:
            Tuple[bool, Optional[LockInfo]]:
                A tuple where the first element indicates whether the lock was successfully
                acquired (True if successful, False otherwise), and the second element is
                an instance of LockInfo representing the lock's current state. If the lock
                was not previously held, this will be None.

        Raises:
            Exception:
                Any unforeseen errors encountered during the execution will be raised to
                the caller.

        Notes:
            - The function uses BEGIN IMMEDIATE to ensure a write lock is applied immediately
              on the database, preventing race conditions during the lock acquisition process.
            - If the lock has expired, it is reassigned to the current owner.
            - Re-entrant locking is allowed for the same owner, increasing the connection
              count for such cases.
            - In case of errors, the transaction is rolled back, and database resources
              are appropriately closed in the cleanup process.
        """
        now = time.time()
        con = self._connect()
        try:
            # BEGIN IMMEDIATE ensures we take a write lock early, preventing racey inserts.
            con.execute("BEGIN IMMEDIATE;")

            row = con.execute(
                "SELECT lock_key, owner, acquired_at, heartbeat_at, connections FROM doc_locks WHERE lock_key=?",
                (lock_key,),
            ).fetchone()

            if row is None:
                con.execute(
                    "INSERT INTO doc_locks(lock_key, owner, acquired_at, heartbeat_at, connections) VALUES(?,?,?,?,1)",
                    (lock_key, owner, now, now),
                )
                con.commit()
                return True, None

            info = LockInfo(
                lock_key=row["lock_key"],
                owner=row["owner"],
                acquired_at=row["acquired_at"],
                heartbeat_at=row["heartbeat_at"],
                connections=row["connections"],
            )

            # If expired, steal the lock
            if self._is_expired(info.heartbeat_at):
                con.execute(
                    """
                    UPDATE doc_locks
                    SET owner=?,
                        acquired_at=?,
                        heartbeat_at=?,
                        connections=1
                    WHERE lock_key = ?
                    """,
                    (owner, now, now, lock_key),
                )
                con.commit()
                return True, info

            # If same owner, allow re-entrant (multi-tab). Remove this if you want strict single-connection.
            if info.owner == owner:
                con.execute(
                    """
                    UPDATE doc_locks
                    SET heartbeat_at=?,
                        connections=connections + 1
                    WHERE lock_key = ?
                      AND owner = ?
                    """,
                    (now, lock_key, owner),
                )
                con.commit()
                return True, info

            # Held by someone else and not expired
            con.commit()
            return False, info

        except Exception:
            con.rollback()
            raise
        finally:
            con.close()

    def _release_sync(self, lock_key: str, owner: str) -> bool:
        con = self._connect()
        try:
            con.execute("BEGIN IMMEDIATE;")
            row = con.execute(
                "SELECT connections FROM doc_locks WHERE lock_key=? AND owner=?",
                (lock_key, owner),
            ).fetchone()
            if row is None:
                con.commit()
                return False

            connections = int(row["connections"])
            if connections <= 1:
                con.execute("DELETE FROM doc_locks WHERE lock_key=? AND owner=?", (lock_key, owner))
            else:
                con.execute(
                    "UPDATE doc_locks SET connections=connections-1, heartbeat_at=? WHERE lock_key=? AND owner=?",
                    (time.time(), lock_key, owner),
                )
            con.commit()
            return True
        except Exception:
            con.rollback()
            raise
        finally:
            con.close()

    def _heartbeat_sync(self, lock_key: str, owner: str) -> bool:
        con = self._connect()
        try:
            res = con.execute(
                "UPDATE doc_locks SET heartbeat_at=? WHERE lock_key=? AND owner=?",
                (time.time(), lock_key, owner),
            )
            con.commit()
            return res.rowcount == 1
        finally:
            con.close()

    def _get_sync(self, lock_key: str) -> Optional[LockInfo]:
        con = self._connect()
        try:
            row = con.execute(
                "SELECT lock_key, owner, acquired_at, heartbeat_at, connections FROM doc_locks WHERE lock_key=?",
                (lock_key,),
            ).fetchone()
            if row is None:
                return None
            return LockInfo(
                lock_key=row["lock_key"],
                owner=row["owner"],
                acquired_at=row["acquired_at"],
                heartbeat_at=row["heartbeat_at"],
                connections=row["connections"],
            )
        finally:
            con.close()
