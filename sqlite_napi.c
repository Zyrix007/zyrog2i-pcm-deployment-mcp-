#include <node_api.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct sqlite3 sqlite3;
typedef struct sqlite3_stmt sqlite3_stmt;
typedef struct sqlite3_backup sqlite3_backup;
typedef void (*sqlite3_destructor_type)(void*);

#define SQLITE_OK           0
#define SQLITE_ROW          100
#define SQLITE_DONE         101

#define SQLITE_INTEGER      1
#define SQLITE_FLOAT        2
#define SQLITE_TEXT         3
#define SQLITE_BLOB         4
#define SQLITE_NULL         5

#define SQLITE_OPEN_READWRITE    0x00000002
#define SQLITE_OPEN_CREATE       0x00000004
#define SQLITE_OPEN_URI          0x00000040

#define SQLITE_TRANSIENT    ((sqlite3_destructor_type)-1)

extern const char* sqlite3_libversion(void);
extern int sqlite3_open_v2(const char* filename, sqlite3** ppDb, int flags, const char* zVfs);
extern int sqlite3_close_v2(sqlite3* db);
extern int sqlite3_busy_timeout(sqlite3* db, int ms);
extern int sqlite3_exec(sqlite3* db, const char* sql, int (*callback)(void*,int,char**,char**), void* arg, char** errmsg);
extern void sqlite3_free(void* ptr);
extern int sqlite3_prepare_v2(sqlite3* db, const char* zSql, int nByte, sqlite3_stmt** ppStmt, const char** pzTail);
extern int sqlite3_step(sqlite3_stmt* pStmt);
extern int sqlite3_finalize(sqlite3_stmt* pStmt);
extern int sqlite3_bind_null(sqlite3_stmt* pStmt, int idx);
extern int sqlite3_bind_int64(sqlite3_stmt* pStmt, int idx, int64_t val);
extern int sqlite3_bind_double(sqlite3_stmt* pStmt, int idx, double val);
extern int sqlite3_bind_text(sqlite3_stmt* pStmt, int idx, const char* val, int n, sqlite3_destructor_type destructor);
extern int sqlite3_column_count(sqlite3_stmt* pStmt);
extern const char* sqlite3_column_name(sqlite3_stmt* pStmt, int N);
extern int sqlite3_column_type(sqlite3_stmt* pStmt, int iCol);
extern int64_t sqlite3_column_int64(sqlite3_stmt* pStmt, int iCol);
extern double sqlite3_column_double(sqlite3_stmt* pStmt, int iCol);
extern const unsigned char* sqlite3_column_text(sqlite3_stmt* pStmt, int iCol);
extern int sqlite3_column_bytes(sqlite3_stmt* pStmt, int iCol);
extern int sqlite3_changes(sqlite3* db);
extern int64_t sqlite3_last_insert_rowid(sqlite3* db);
extern const char* sqlite3_errmsg(sqlite3* db);
extern int sqlite3_errcode(sqlite3* db);
extern int sqlite3_extended_errcode(sqlite3* db);
extern sqlite3_backup* sqlite3_backup_init(sqlite3* pDest, const char* zDestName, sqlite3* pSource, const char* zSourceName);
extern int sqlite3_backup_step(sqlite3_backup* p, int nPage);
extern int sqlite3_backup_finish(sqlite3_backup* p);

typedef struct {
  sqlite3* db;
  int closed;
} DbHandle;

static void FinalizeDbHandle(napi_env env, void* finalize_data, void* finalize_hint) {
  DbHandle* handle = (DbHandle*)finalize_data;
  if (handle) {
    if (handle->db && !handle->closed) {
      sqlite3_close_v2(handle->db);
      handle->db = NULL;
      handle->closed = 1;
    }
    free(handle);
  }
}

static void ThrowSqliteError(napi_env env, sqlite3* db, const char* fallback_msg) {
  const char* msg = db ? sqlite3_errmsg(db) : fallback_msg;
  int errcode = db ? sqlite3_extended_errcode(db) : -1;
  char buf[1024];
  snprintf(buf, sizeof(buf), "SQLITE_ERROR (%d): %s", errcode, msg ? msg : "Unknown error");
  napi_throw_error(env, "SQLITE_ERROR", buf);
}

static napi_value OpenDb(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc < 1) {
    napi_throw_error(env, "INVALID_ARGS", "Filename required");
    return NULL;
  }

  size_t str_len = 0;
  napi_get_value_string_utf8(env, args[0], NULL, 0, &str_len);
  char* filename = (char*)malloc(str_len + 1);
  napi_get_value_string_utf8(env, args[0], filename, str_len + 1, &str_len);

  if (strcmp(filename, ":memory:") == 0) {
    free(filename);
    napi_throw_error(env, "STORAGE_UNAVAILABLE", "In-memory SQLite storage is forbidden by PCM specification");
    return NULL;
  }

  sqlite3* db = NULL;
  int rc = sqlite3_open_v2(filename, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_URI, NULL);
  free(filename);

  if (rc != SQLITE_OK || !db) {
    ThrowSqliteError(env, db, "Failed to open SQLite database");
    if (db) sqlite3_close_v2(db);
    return NULL;
  }

  sqlite3_busy_timeout(db, 5000);

  DbHandle* handle = (DbHandle*)malloc(sizeof(DbHandle));
  handle->db = db;
  handle->closed = 0;

  napi_value external;
  napi_create_external(env, handle, FinalizeDbHandle, NULL, &external);
  return external;
}

static DbHandle* UnwrapDb(napi_env env, napi_value val) {
  DbHandle* handle = NULL;
  napi_status status = napi_get_value_external(env, val, (void**)&handle);
  if (status != napi_ok || !handle || handle->closed || !handle->db) {
    napi_throw_error(env, "STORAGE_UNAVAILABLE", "Database connection is closed or invalid");
    return NULL;
  }
  return handle;
}

static napi_value CloseDb(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  DbHandle* handle = NULL;
  if (argc >= 1 && napi_get_value_external(env, args[0], (void**)&handle) == napi_ok && handle) {
    if (handle->db && !handle->closed) {
      sqlite3_close_v2(handle->db);
      handle->db = NULL;
      handle->closed = 1;
    }
  }
  napi_value undef;
  napi_get_undefined(env, &undef);
  return undef;
}

static napi_value ExecSql(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  DbHandle* handle = UnwrapDb(env, args[0]);
  if (!handle) return NULL;

  size_t sql_len = 0;
  napi_get_value_string_utf8(env, args[1], NULL, 0, &sql_len);
  char* sql = (char*)malloc(sql_len + 1);
  napi_get_value_string_utf8(env, args[1], sql, sql_len + 1, &sql_len);

  char* errmsg = NULL;
  int rc = sqlite3_exec(handle->db, sql, NULL, NULL, &errmsg);
  free(sql);

  if (rc != SQLITE_OK) {
    char buf[1024];
    int ext_code = sqlite3_extended_errcode(handle->db);
    snprintf(buf, sizeof(buf), "SQLITE_ERROR (%d): %s", ext_code, errmsg ? errmsg : sqlite3_errmsg(handle->db));
    if (errmsg) sqlite3_free(errmsg);
    napi_throw_error(env, "SQLITE_ERROR", buf);
    return NULL;
  }

  napi_value undef;
  napi_get_undefined(env, &undef);
  return undef;
}

static int BindParams(napi_env env, sqlite3* db, sqlite3_stmt* stmt, napi_value params_arr) {
  bool is_array = false;
  napi_is_array(env, params_arr, &is_array);
  if (!is_array) return 1;

  uint32_t len = 0;
  napi_get_array_length(env, params_arr, &len);

  for (uint32_t i = 0; i < len; i++) {
    napi_value elem;
    napi_get_element(env, params_arr, i, &elem);
    napi_valuetype vtype;
    napi_typeof(env, elem, &vtype);

    int idx = (int)(i + 1);
    int rc = SQLITE_OK;

    if (vtype == napi_null || vtype == napi_undefined) {
      rc = sqlite3_bind_null(stmt, idx);
    } else if (vtype == napi_boolean) {
      bool bval = false;
      napi_get_value_bool(env, elem, &bval);
      rc = sqlite3_bind_int64(stmt, idx, bval ? 1 : 0);
    } else if (vtype == napi_number) {
      double dval = 0;
      napi_get_value_double(env, elem, &dval);
      int64_t ival = (int64_t)dval;
      if ((double)ival == dval && dval >= -9007199254740991.0 && dval <= 9007199254740991.0) {
        rc = sqlite3_bind_int64(stmt, idx, ival);
      } else {
        rc = sqlite3_bind_double(stmt, idx, dval);
      }
    } else if (vtype == napi_string) {
      size_t slen = 0;
      napi_get_value_string_utf8(env, elem, NULL, 0, &slen);
      char* sval = (char*)malloc(slen + 1);
      napi_get_value_string_utf8(env, elem, sval, slen + 1, &slen);
      rc = sqlite3_bind_text(stmt, idx, sval, (int)slen, SQLITE_TRANSIENT);
      free(sval);
    } else {
      napi_value str_coerced;
      if (napi_coerce_to_string(env, elem, &str_coerced) == napi_ok) {
        size_t slen = 0;
        napi_get_value_string_utf8(env, str_coerced, NULL, 0, &slen);
        char* sval = (char*)malloc(slen + 1);
        napi_get_value_string_utf8(env, str_coerced, sval, slen + 1, &slen);
        rc = sqlite3_bind_text(stmt, idx, sval, (int)slen, SQLITE_TRANSIENT);
        free(sval);
      } else {
        rc = sqlite3_bind_null(stmt, idx);
      }
    }

    if (rc != SQLITE_OK) {
      ThrowSqliteError(env, db, "Failed to bind parameter");
      return 0;
    }
  }
  return 1;
}

static napi_value RunSql(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  DbHandle* handle = UnwrapDb(env, args[0]);
  if (!handle) return NULL;

  size_t sql_len = 0;
  napi_get_value_string_utf8(env, args[1], NULL, 0, &sql_len);
  char* sql = (char*)malloc(sql_len + 1);
  napi_get_value_string_utf8(env, args[1], sql, sql_len + 1, &sql_len);

  sqlite3_stmt* stmt = NULL;
  int rc = sqlite3_prepare_v2(handle->db, sql, (int)sql_len, &stmt, NULL);
  free(sql);

  if (rc != SQLITE_OK || !stmt) {
    ThrowSqliteError(env, handle->db, "Failed to prepare statement");
    return NULL;
  }

  if (argc >= 3) {
    if (!BindParams(env, handle->db, stmt, args[2])) {
      sqlite3_finalize(stmt);
      return NULL;
    }
  }

  rc = sqlite3_step(stmt);
  if (rc != SQLITE_DONE && rc != SQLITE_ROW) {
    ThrowSqliteError(env, handle->db, "Failed to step statement");
    sqlite3_finalize(stmt);
    return NULL;
  }

  int changes = sqlite3_changes(handle->db);
  int64_t last_id = sqlite3_last_insert_rowid(handle->db);
  sqlite3_finalize(stmt);

  napi_value res, changes_val, last_id_val;
  napi_create_object(env, &res);
  napi_create_int32(env, changes, &changes_val);
  napi_create_int64(env, last_id, &last_id_val);
  napi_set_named_property(env, res, "changes", changes_val);
  napi_set_named_property(env, res, "lastInsertRowid", last_id_val);
  return res;
}

static napi_value QuerySql(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  DbHandle* handle = UnwrapDb(env, args[0]);
  if (!handle) return NULL;

  size_t sql_len = 0;
  napi_get_value_string_utf8(env, args[1], NULL, 0, &sql_len);
  char* sql = (char*)malloc(sql_len + 1);
  napi_get_value_string_utf8(env, args[1], sql, sql_len + 1, &sql_len);

  sqlite3_stmt* stmt = NULL;
  int rc = sqlite3_prepare_v2(handle->db, sql, (int)sql_len, &stmt, NULL);
  free(sql);

  if (rc != SQLITE_OK || !stmt) {
    ThrowSqliteError(env, handle->db, "Failed to prepare query");
    return NULL;
  }

  if (argc >= 3) {
    if (!BindParams(env, handle->db, stmt, args[2])) {
      sqlite3_finalize(stmt);
      return NULL;
    }
  }

  napi_value rows;
  napi_create_array(env, &rows);
  uint32_t row_idx = 0;
  int col_count = sqlite3_column_count(stmt);

  while ((rc = sqlite3_step(stmt)) == SQLITE_ROW) {
    napi_value row_obj;
    napi_create_object(env, &row_obj);

    for (int col = 0; col < col_count; col++) {
      const char* col_name = sqlite3_column_name(stmt, col);
      int col_type = sqlite3_column_type(stmt, col);
      napi_value val;

      if (col_type == SQLITE_NULL) {
        napi_get_null(env, &val);
      } else if (col_type == SQLITE_INTEGER) {
        int64_t ival = sqlite3_column_int64(stmt, col);
        napi_create_int64(env, ival, &val);
      } else if (col_type == SQLITE_FLOAT) {
        double dval = sqlite3_column_double(stmt, col);
        napi_create_double(env, dval, &val);
      } else {
        const unsigned char* text = sqlite3_column_text(stmt, col);
        int bytes = sqlite3_column_bytes(stmt, col);
        if (text) {
          napi_create_string_utf8(env, (const char*)text, (size_t)bytes, &val);
        } else {
          napi_get_null(env, &val);
        }
      }
      napi_set_named_property(env, row_obj, col_name ? col_name : "", val);
    }

    napi_set_element(env, rows, row_idx++, row_obj);
  }

  if (rc != SQLITE_DONE) {
    ThrowSqliteError(env, handle->db, "Error stepping query results");
    sqlite3_finalize(stmt);
    return NULL;
  }

  sqlite3_finalize(stmt);
  return rows;
}

static napi_value BackupDb(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  DbHandle* handle = UnwrapDb(env, args[0]);
  if (!handle) return NULL;

  size_t dest_len = 0;
  napi_get_value_string_utf8(env, args[1], NULL, 0, &dest_len);
  char* dest_path = (char*)malloc(dest_len + 1);
  napi_get_value_string_utf8(env, args[1], dest_path, dest_len + 1, &dest_len);

  sqlite3* dest_db = NULL;
  int rc = sqlite3_open_v2(dest_path, &dest_db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, NULL);
  free(dest_path);

  if (rc != SQLITE_OK || !dest_db) {
    ThrowSqliteError(env, dest_db, "Failed to open backup destination database");
    if (dest_db) sqlite3_close_v2(dest_db);
    return NULL;
  }

  sqlite3_backup* backup = sqlite3_backup_init(dest_db, "main", handle->db, "main");
  if (!backup) {
    ThrowSqliteError(env, dest_db, "Failed to initialize SQLite online backup");
    sqlite3_close_v2(dest_db);
    return NULL;
  }

  rc = sqlite3_backup_step(backup, -1);
  int finish_rc = sqlite3_backup_finish(backup);
  sqlite3_close_v2(dest_db);

  if (rc != SQLITE_DONE || finish_rc != SQLITE_OK) {
    ThrowSqliteError(env, handle->db, "SQLite online backup did not complete cleanly");
    return NULL;
  }

  napi_value ok;
  napi_get_boolean(env, true, &ok);
  return ok;
}

static napi_value GetVersion(napi_env env, napi_callback_info info) {
  napi_value res;
  napi_create_string_utf8(env, sqlite3_libversion(), NAPI_AUTO_LENGTH, &res);
  return res;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn_open, fn_close, fn_exec, fn_run, fn_query, fn_backup, fn_version;
  napi_create_function(env, "open", NAPI_AUTO_LENGTH, OpenDb, NULL, &fn_open);
  napi_create_function(env, "close", NAPI_AUTO_LENGTH, CloseDb, NULL, &fn_close);
  napi_create_function(env, "exec", NAPI_AUTO_LENGTH, ExecSql, NULL, &fn_exec);
  napi_create_function(env, "run", NAPI_AUTO_LENGTH, RunSql, NULL, &fn_run);
  napi_create_function(env, "query", NAPI_AUTO_LENGTH, QuerySql, NULL, &fn_query);
  napi_create_function(env, "backup", NAPI_AUTO_LENGTH, BackupDb, NULL, &fn_backup);
  napi_create_function(env, "version", NAPI_AUTO_LENGTH, GetVersion, NULL, &fn_version);

  napi_set_named_property(env, exports, "open", fn_open);
  napi_set_named_property(env, exports, "close", fn_close);
  napi_set_named_property(env, exports, "exec", fn_exec);
  napi_set_named_property(env, exports, "run", fn_run);
  napi_set_named_property(env, exports, "query", fn_query);
  napi_set_named_property(env, exports, "backup", fn_backup);
  napi_set_named_property(env, exports, "version", fn_version);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
