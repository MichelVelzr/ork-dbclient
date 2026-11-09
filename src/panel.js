import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { sql, PostgreSQL, MySQL, MariaSQL, SQLite, MSSQL } from '@codemirror/lang-sql';
import { autocompletion } from '@codemirror/autocomplete';
import './panel.css';

const $ = (id) => document.getElementById(id);
const state = { connections: [], active: null, editor: null, editId: null, pendingDelete: null, objects: [], lastResult: null, baseSql: null, filters: [], applyingFilter: false, filterColumn: null, sqlLanguage: new Compartment() };
const FILTER_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M1 2h14l-5.5 6.2V13L6.5 15V8.2L1 2z" fill="currentColor"/></svg>';
const TYPES = { postgres: 'PostgreSQL', mysql: 'MySQL / MariaDB / Percona', mssql: 'Microsoft SQL Server', sqlite: 'SQLite', redis: 'Redis' };
const orca = window.orca;

function notify(message, isError = false) {
  const toast = $('toast'); toast.textContent = message; toast.className = `toast ${isError ? 'error' : ''}`;
  setTimeout(() => toast.classList.add('hidden'), 3200);
}
async function request(name, input = {}) {
  if (!orca?.plugin?.request) throw new Error('Orca plugin bridge is unavailable. Open this panel in the Orca desktop app.');
  return await orca.plugin.request(name, input, { timeoutMs: 60000 });
}
function activeConnection() { return state.connections.find(c => c.id === state.active); }
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function renderConnections() {
  const list = $('connectionList');
  if (!state.connections.length) { list.innerHTML = '<div class="empty-state">No connections yet.<br/>Add a database to get started.</div>'; return; }
  list.innerHTML = state.connections.map(c => `<div class="connection-item ${c.id === state.active ? 'selected' : ''}" data-id="${esc(c.id)}"><span class="db-icon ${esc(c.type)}">${c.type === 'redis' ? '↯' : c.type === 'sqlite' ? '▣' : '▤'}</span><span class="connection-label"><strong>${esc(c.name)}</strong><small>${esc(TYPES[c.type])}${c.host ? ' · '+esc(c.host) : ''}</small></span><span class="item-actions"><button class="item-menu" data-edit="${esc(c.id)}" title="Edit connection">✎</button><button class="item-menu" data-delete="${esc(c.id)}" title="Delete connection">✕</button></span></div>`).join('');
  list.querySelectorAll('[data-id]').forEach(el => el.addEventListener('click', () => selectConnection(el.dataset.id)));
  list.querySelectorAll('[data-edit]').forEach(el => el.addEventListener('click', e => { e.stopPropagation(); editConnection(el.dataset.edit); }));
  list.querySelectorAll('[data-delete]').forEach(el => el.addEventListener('click', e => { e.stopPropagation(); deleteConnection(el.dataset.delete); }));
}
function showConnection() {
  const c = activeConnection();
  $('welcome').classList.toggle('hidden', Boolean(c)); $('databaseView').classList.toggle('hidden', !c);
  if (!c) return;
  $('connectionName').textContent = c.name; $('connectionType').textContent = TYPES[c.type].toUpperCase();
  $('connectionMeta').textContent = c.type === 'sqlite' ? c.filePath : `${c.host}:${c.port}${c.database ? ' · '+c.database : ''}`;
  $('connectionStatus').textContent = 'Saved'; $('connectionStatus').className = 'status';
  document.querySelector('[data-tab="redis"]').classList.toggle('hidden', c.type !== 'redis');
  document.querySelector('[data-tab="query"]').classList.toggle('hidden', c.type === 'redis');
  if (c.type === 'redis') activateTab('redis'); else activateTab('query');
  if (state.editor) {
    const lang = c.type === 'postgres' ? PostgreSQL : c.type === 'sqlite' ? SQLite : c.type === 'mysql' ? MySQL : c.type === 'mssql' ? MSSQL : MariaSQL;
    state.editor.dispatch({ effects: state.sqlLanguage.reconfigure(sql({ dialect: lang })) });
  }
}
async function selectConnection(id) {
  state.active = id; state.baseSql = null; state.filters = []; closeFilterPopover(); renderConnections(); showConnection();
  try { await loadObjects(); } catch (e) { notify(e.message, true); }
}
function activateTab(tab) {
  document.querySelectorAll('.tab').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
  $('queryTab').classList.toggle('hidden', tab !== 'query'); $('redisTab').classList.toggle('hidden', tab !== 'redis'); $('objectsTab').classList.toggle('hidden', tab !== 'objects');
}
function setupEditor() {
  const parent = $('sqlEditor');
  const startState = EditorState.create({ doc: $('sqlInput').value, extensions: [lineNumbers(), history(), keymap.of([...defaultKeymap, ...historyKeymap]), state.sqlLanguage.of(sql({ dialect: PostgreSQL })), autocompletion(), EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } })] });
  state.editor = new EditorView({ state: startState, parent });
  $('sqlInput').remove();
}
function quoteIdent(name) {
  const c = activeConnection();
  const value = String(name);
  if (c?.type === 'mysql') return `\`${value.replace(/`/g, '``')}\``;
  if (c?.type === 'mssql') return `[${value.replace(/]/g, ']]')}]`;
  return `"${value.replace(/"/g, '""')}"`;
}
function sqlLiteral(value) { return `'${String(value).replace(/'/g, "''")}'`; }
function scanTopLevel(sql) {
  const trailingPattern = /^(order\s+by|group\s+by|having|limit|offset|fetch|for|union|except|intersect|option)\b/i;
  let depth = 0, whereIndex = -1, trailingIndex = -1, endsInLineComment = false;
  for (let i = 0; i < sql.length;) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch; i++;
      while (i < sql.length) { if (sql[i] === quote) { if (sql[i + 1] === quote) { i += 2; continue; } i++; break; } i++; }
      continue;
    }
    if (ch === '[') {
      i++;
      while (i < sql.length) { if (sql[i] === ']') { if (sql[i + 1] === ']') { i += 2; continue; } i++; break; } i++; }
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') { i += 2; endsInLineComment = true; while (i < sql.length && sql[i] !== '\n') i++; if (i < sql.length) { endsInLineComment = false; i++; } continue; }
    if (ch === '/' && sql[i + 1] === '*') { i += 2; while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++; i += 2; continue; }
    if (ch === '(') { depth++; i++; continue; }
    if (ch === ')') { depth = Math.max(0, depth - 1); i++; continue; }
    if (depth === 0 && /[A-Za-z]/.test(ch) && (i === 0 || !/[A-Za-z0-9_$]/.test(sql[i - 1]))) {
      const rest = sql.slice(i);
      if (whereIndex < 0 && /^where\b/i.test(rest)) whereIndex = i;
      if (trailingIndex < 0 && trailingPattern.test(rest)) trailingIndex = i;
    }
    i++;
  }
  return { whereIndex, trailingIndex, endsInLineComment };
}
function buildFilteredSql() {
  const original = String(state.baseSql || '').trim();
  if (!state.filters.length) return original;
  const hadSemicolon = original.endsWith(';');
  const body = (hadSemicolon ? original.slice(0, -1) : original).replace(/\s+$/, '');
  const { whereIndex, trailingIndex, endsInLineComment } = scanTopLevel(body);
  const conditions = state.filters.map(f => `${quoteIdent(f.column)} LIKE ${sqlLiteral('%' + f.value + '%')}`).join(' AND ');
  const insertAt = trailingIndex >= 0 ? trailingIndex : body.length;
  const rawBefore = body.slice(0, insertAt), rawAfter = body.slice(insertAt);
  const before = rawBefore.replace(/\s+$/, ''), after = rawAfter.replace(/^\s+/, '');
  const gap = rawBefore.slice(before.length) + rawAfter.slice(0, rawAfter.length - after.length);
  const sep = (/\n/.test(gap) || endsInLineComment) ? '\n' : ' ';
  const next = whereIndex >= 0
    ? `${before}${sep}AND ${conditions}${after ? ' ' + after : ''}`
    : `${before}${sep}WHERE ${conditions}${after ? ' ' + after : ''}`;
  return next + (hadSemicolon ? ';' : '');
}
function applyFilter(column, value) {
  const c = activeConnection(); if (!c) return;
  if (!state.baseSql) state.baseSql = state.editor.state.doc.toString().trim();
  const trimmed = String(value || '').trim();
  const existing = state.filters.find(f => f.column === column);
  if (trimmed) { if (existing) existing.value = trimmed; else state.filters.push({ column, value: trimmed }); }
  else if (existing) state.filters = state.filters.filter(f => f.column !== column);
  const nextSql = buildFilteredSql();
  state.editor.dispatch({ changes: { from: 0, to: state.editor.state.doc.length, insert: nextSql } });
  closeFilterPopover();
  state.applyingFilter = true;
  runQuery().finally(() => { state.applyingFilter = false; });
}
function openFilterPopover(anchor, column) {
  state.filterColumn = column;
  const existing = state.filters.find(f => f.column === column);
  $('filterTitle').textContent = `Filter ${column}`;
  $('filterValue').value = existing?.value || '';
  $('filterClear').classList.toggle('hidden', !existing);
  const pop = $('filterPopover'); pop.classList.remove('hidden');
  const rect = anchor.getBoundingClientRect();
  pop.style.top = `${rect.bottom + 6}px`;
  pop.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 248))}px`;
  $('filterValue').focus();
  $('filterValue').select();
}
function closeFilterPopover() { state.filterColumn = null; $('filterPopover').classList.add('hidden'); }
function clearFilters() {
  if (!state.filters.length) return;
  state.filters = [];
  const nextSql = buildFilteredSql();
  state.editor.dispatch({ changes: { from: 0, to: state.editor.state.doc.length, insert: nextSql } });
  closeFilterPopover();
  state.applyingFilter = true;
  runQuery().finally(() => { state.applyingFilter = false; });
}
function renderResults(result) {
  state.lastResult = result;
  $('exportCsv').disabled = !(result.rows || []).length; $('exportJson').disabled = !(result.rows || []).length;
  const root = $('queryResults');
  const rows = result.rows || [];
  $('clearFilters').classList.toggle('hidden', !state.filters.length);
  $('resultMeta').textContent = `${result.rowCount ?? rows.length} row(s)${result.truncated ? ' · first 500 shown' : ''}${result.command ? ' · '+result.command : ''}`;
  if (!rows.length) { root.innerHTML = `<div class="empty-state">Query completed. ${esc(result.rowCount ?? 0)} affected row(s).</div>`; return; }
  const cols = result.fields?.length ? result.fields : Object.keys(rows[0]);
  closeFilterPopover();
  root.innerHTML = `<div class="table-wrap"><table><thead><tr>${cols.map(col => { const active = state.filters.some(f => f.column === col); return `<th><span class="th-label">${esc(col)}</span><button type="button" class="filter-btn${active ? ' active' : ''}" data-filter="${esc(col)}" title="Filter ${esc(col)}">${FILTER_ICON}</button></th>`; }).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${cols.map(c => `<td title="${esc(formatCell(row[c]))}">${esc(formatCell(row[c]))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  root.querySelectorAll('[data-filter]').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); openFilterPopover(btn, btn.dataset.filter); }));
}
async function exportResult(format) {
  const result = state.lastResult; if (!result?.rows?.length) return;
  const columns = result.fields?.length ? result.fields : Object.keys(result.rows[0]);
  let content, mime, extension;
  if (format === 'json') { content = JSON.stringify(result.rows, null, 2); mime = 'application/json'; extension = 'json'; }
  else { const quote = value => `\"${String(value ?? '').replace(/\"/g, '\"\"')}\"`; content = [columns.map(quote).join(','), ...result.rows.map(row => columns.map(col => quote(row[col])).join(','))].join('\r\n'); mime = 'text/csv;charset=utf-8'; extension = 'csv'; }
  try { const saved = await orca.files.saveAs({ suggestedName: `query-results.${extension}`, mimeType: mime, data: content }); if (saved.status === 'saved') notify('Export saved.'); } catch (error) { notify(error.message, true); }
}
function formatCell(value) { if (value === null) return 'NULL'; if (value === undefined) return ''; if (typeof value === 'object') return JSON.stringify(value); return String(value); }
async function runQuery() {
  const c = activeConnection(); if (!c) return;
  const sqlText = state.editor.state.doc.toString().trim(); if (!sqlText) return;
  if (!state.applyingFilter) { state.baseSql = sqlText; state.filters = []; }
  $('runQuery').disabled = true; $('runQuery').textContent = 'Running…';
  try { const result = await request('database.query', { id: c.id, sql: sqlText }); renderResults(result); $('connectionStatus').textContent = 'Connected'; $('connectionStatus').className = 'status online'; }
  catch (e) { $('queryResults').innerHTML = `<div class="error-panel">${esc(e.message)}</div>`; notify(e.message, true); }
  finally { $('runQuery').disabled = false; $('runQuery').textContent = '▶ Run query'; }
}
async function loadObjects() {
  const c = activeConnection(); if (!c) return;
  $('objectList').innerHTML = '<div class="loading">Loading database objects…</div>';
  const objects = await request('database.tree', { id: c.id }); state.objects = objects;
  if (c.type === 'redis') {
    $('objectList').innerHTML = '<div class="object-row"><span>↯</span><strong>Redis keyspace</strong><small>Use the Redis Console and SCAN to browse keys.</small></div>';
    return;
  }
  if (!objects.length) { $('objectList').innerHTML = '<div class="empty-state">No tables or views found.</div>'; return; }
  const groups = new Map();
  for (const o of objects) {
    const database = o.db_name || o.database || o.schema_name || (c.type === 'postgres' ? o.schema : '') || 'main';
    if (!groups.has(database)) groups.set(database, []);
    groups.get(database).push(o);
  }
  $('objectList').innerHTML = [...groups.entries()].map(([database, items]) => {
    const rows = items.map(o => {
      const schema = o.schema || o.schema_name || '';
      const detail = (c.type === 'postgres' || c.type === 'mssql') && schema ? `${schema} · ${o.kind || 'table'}` : (o.kind || 'table');
      return `<div class="object-row"><span>▦</span><div><strong>${esc(o.name)}</strong><small>${esc(detail)}</small></div><button class="ghost" data-table="${esc(o.name)}" data-schema="${esc(schema)}">SELECT</button></div>`;
    }).join('');
    return `<div class="object-group"><button type="button" class="object-group-header" data-group-toggle><span class="group-chevron">▸</span><span class="db-icon">▤</span><span class="object-group-label"><strong>${esc(database)}</strong><small>${items.length} ${items.length === 1 ? 'table/view' : 'tables/views'}</small></span></button><div class="object-group-body hidden">${rows}</div></div>`;
  }).join('');
  $('objectList').querySelectorAll('[data-group-toggle]').forEach(btn => btn.addEventListener('click', () => {
    const body = btn.nextElementSibling; const collapsed = body.classList.toggle('hidden');
    btn.classList.toggle('open', !collapsed);
  }));
  $('objectList').querySelectorAll('[data-table]').forEach(btn => btn.addEventListener('click', () => {
    const schema = btn.dataset.schema; const table = btn.dataset.table;
    const quoteName = value => c.type === 'mysql' ? `\`${value}\`` : c.type === 'mssql' ? `[${value}]` : `"${value}"`;
    const target = schema && (c.type === 'postgres' || c.type === 'mysql' || c.type === 'mssql') ? `${quoteName(schema)}.${quoteName(table)}` : quoteName(table);
    state.editor.dispatch({ changes: { from: 0, to: state.editor.state.doc.length, insert: `SELECT * FROM ${target} LIMIT 100;` } });
    activateTab('query');
  }));
}
async function testConnection() {
  const c = activeConnection(); if (!c) return;
  $('testConnection').disabled = true; $('testConnection').textContent = 'Testing…';
  try { const result = await request('connections.test', { id: c.id }); $('connectionStatus').textContent = 'Connected'; $('connectionStatus').className = 'status online'; notify(result.message); }
  catch (e) { $('connectionStatus').textContent = 'Error'; $('connectionStatus').className = 'status offline'; notify(e.message, true); }
  finally { $('testConnection').disabled = false; $('testConnection').textContent = 'Test connection'; }
}
async function runRedis() {
  const c = activeConnection(); if (!c || c.type !== 'redis') return;
  const command = $('redisInput').value.trim(); if (!command) return;
  $('runRedis').disabled = true;
  try { const result = await request('redis.command', { id: c.id, command }); $('redisOutput').textContent = typeof result.result === 'string' ? result.result : JSON.stringify(result.result, null, 2); }
  catch (e) { $('redisOutput').textContent = `ERROR: ${e.message}`; }
  finally { $('runRedis').disabled = false; }
}
function showModal(connection = null) {
  const form = $('connectionForm');
  form.reset();
  state.editId = connection?.id || null;
  $('modalTitle').textContent = connection ? 'Edit connection' : 'Connect to a database';
  $('formError').textContent = '';
  const elements = form.elements;
  elements.type.value = connection?.type || 'postgres';
  updateTypeFields();
  elements.name.value = connection?.name || '';
  elements.password.value = '';
  elements.password.placeholder = connection ? 'Leave blank to keep the current password' : '';
  if (connection?.type === 'sqlite') {
    elements.filePath.value = connection.filePath || '';
  } else if (connection) {
    elements.host.value = connection.host || '127.0.0.1';
    if (connection.port) elements.port.value = connection.port;
    elements.database.value = connection.database || '';
    elements.username.value = connection.username || '';
    elements.ssl.checked = Boolean(connection.ssl);
  }
  $('modalBackdrop').classList.remove('hidden');
}
function hideModal() { $('modalBackdrop').classList.add('hidden'); }
function editConnection(id) { const c = state.connections.find(x => x.id === id); if (c) showModal(c); }
function updateTypeFields() {
  const type = $('dbType').value; $('networkFields').classList.toggle('hidden', type === 'sqlite'); $('sqliteFields').classList.toggle('hidden', type !== 'sqlite');
  $('databaseLabel').classList.toggle('hidden', type === 'sqlite');
  $('databaseLabelText').textContent = type === 'redis' ? 'Database number' : 'Database';
  const port = $('connectionForm').elements.port; if (port) port.value = type === 'postgres' ? 5432 : type === 'mssql' ? 1433 : type === 'redis' ? 6379 : 3306;
  $('connectionForm').elements.database.placeholder = type === 'redis' ? '0' : 'Leave empty to use the default database';
}
async function saveConnection(event) {
  event.preventDefault(); const form = new FormData(event.currentTarget); const type = String(form.get('type'));
  const data = { type, name: form.get('name') };
  if (state.editId) data.id = state.editId;
  if (type === 'sqlite') data.filePath = form.get('filePath');
  else Object.assign(data, { password: form.get('password') || '', host: form.get('host'), port: Number(form.get('port')), database: form.get('database'), username: form.get('username'), ssl: form.get('ssl') === 'on' });
  try { const saved = await request('connections.save', data); await refreshConnections(); hideModal(); await selectConnection(saved.id); notify('Connection saved.'); }
  catch (e) { $('formError').textContent = e.message; }
}
async function refreshConnections() { state.connections = await request('connections.list'); renderConnections(); }
function deleteConnection(id) {
  const c = state.connections.find(x => x.id === id); if (!c) return;
  state.pendingDelete = id;
  $('deleteTitle').textContent = `Delete “${c.name}”?`;
  $('deleteMessage').textContent = 'This removes the saved connection and its stored password.';
  $('deleteBackdrop').classList.remove('hidden');
}
function closeDelete() { state.pendingDelete = null; $('deleteBackdrop').classList.add('hidden'); }
async function performDelete() {
  const id = state.pendingDelete; if (!id) return;
  $('confirmDelete').disabled = true;
  try {
    await request('connections.delete', { id });
    if (state.active === id) state.active = null;
    closeDelete(); await refreshConnections(); showConnection(); notify('Connection deleted.');
  } catch (e) { notify(e.message, true); }
  finally { $('confirmDelete').disabled = false; }
}

$('addConnection').addEventListener('click', () => showModal()); $('welcomeAdd').addEventListener('click', () => showModal());
$('closeModal').addEventListener('click', hideModal); $('cancelModal').addEventListener('click', hideModal);
$('closeDelete').addEventListener('click', closeDelete); $('cancelDelete').addEventListener('click', closeDelete); $('confirmDelete').addEventListener('click', performDelete);
$('dbType').addEventListener('change', updateTypeFields); $('connectionForm').addEventListener('submit', saveConnection);
$('refreshConnections').addEventListener('click', () => refreshConnections().catch(e => notify(e.message, true)));
$('editConnection').addEventListener('click', () => { const c = activeConnection(); if (c) showModal(c); });
$('testConnection').addEventListener('click', testConnection); $('runQuery').addEventListener('click', runQuery);
$('clearQuery').addEventListener('click', () => state.editor.dispatch({ changes: { from: 0, to: state.editor.state.doc.length, insert: '' } }));
$('exportCsv').addEventListener('click', () => exportResult('csv')); $('exportJson').addEventListener('click', () => exportResult('json'));
$('clearFilters').addEventListener('click', clearFilters);
$('runRedis').addEventListener('click', runRedis); $('redisInput').addEventListener('keydown', e => { if (e.key === 'Enter') runRedis(); });
$('filterApply').addEventListener('click', () => { if (state.filterColumn) applyFilter(state.filterColumn, $('filterValue').value); });
$('filterClear').addEventListener('click', () => { if (state.filterColumn) applyFilter(state.filterColumn, ''); });
$('filterValue').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('filterApply').click(); } else if (e.key === 'Escape') closeFilterPopover(); });
document.addEventListener('click', e => { if (state.filterColumn && !e.target.closest('#filterPopover') && !e.target.closest('.filter-btn')) closeFilterPopover(); });
$('refreshObjects').addEventListener('click', () => loadObjects().catch(e => notify(e.message, true)));
document.querySelectorAll('.tab').forEach(el => el.addEventListener('click', () => activateTab(el.dataset.tab)));
setupEditor();
refreshConnections().then(() => { if (state.connections.length) selectConnection(state.connections[0].id); }).catch(e => notify(e.message, true));
window.addEventListener('beforeunload', () => { request('connections.closeAll').catch(() => {}); });
