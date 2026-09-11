import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { api } from '../../app/api';

const STATUSES = ['', 'open', 'pending', 'resolved', 'closed'];
const PRIORITIES = ['', 'P1', 'P2', 'P3'];

export default function TicketList() {
  const user = useSelector((s) => s.auth.user);

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [status, setStatus] = useState('');
  const [priority, setPriority] = useState('');
  const [sortBy, setSortBy] = useState('created_at');
  const [breachedOnly, setBreachedOnly] = useState(false);
  const [loading, setLoading] = useState(false);

  // Debounce the search box so we don't fire a request per keystroke.
  useEffect(() => {
    const handle = setTimeout(() => {
      setSearch(searchInput);
      setPage(1);
    }, 300);
    return () => clearTimeout(handle);
  }, [searchInput]);

  // NOTE: this effect used to only watch `page`, so search/status/priority/
  // sortBy silently did nothing until the page number changed (Part 1
  // review, finding #6). The breached-only filter added here needs the
  // same refetch, so this dependency array was corrected as part of Part 2
  // — see DECISIONS.md.
  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({
      page, search, status, priority, sortBy, order: 'desc',
      ...(breachedOnly ? { breached: 'true' } : {}),
    });
    api(`/tickets?${params.toString()}`)
      .then((data) => {
        setRows(data.rows);
        setTotal(data.total);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [page, search, status, priority, sortBy, breachedOnly]);

  // Any filter change other than the page itself starts back at page 1 —
  // otherwise you can land on a page number past the end of a narrower
  // result set and see an empty table.
  function updateFilter(setter) {
    return (value) => {
      setter(value);
      setPage(1);
    };
  }

  async function handleDelete(id) {
    await api(`/tickets/${id}`, { method: 'DELETE' });
    setRows(rows.filter((r) => r.id !== id));
  }

  const pageCount = Math.ceil(total / 20);

  return (
    <div className="ticket-list">
      <h1>Tickets</h1>

      <div className="filters">
        <input
          placeholder="Search subject…"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
        <select value={status} onChange={(e) => updateFilter(setStatus)(e.target.value)}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{s || 'Any status'}</option>
          ))}
        </select>
        <select value={priority} onChange={(e) => updateFilter(setPriority)(e.target.value)}>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>{p || 'Any priority'}</option>
          ))}
        </select>
        <select value={sortBy} onChange={(e) => updateFilter(setSortBy)(e.target.value)}>
          <option value="created_at">Created</option>
          <option value="updated_at">Updated</option>
          <option value="priority">Priority</option>
          <option value="status">Status</option>
        </select>
        <label className="breached-filter">
          <input
            type="checkbox"
            checked={breachedOnly}
            onChange={(e) => updateFilter(setBreachedOnly)(e.target.checked)}
          />
          Breached only
        </label>
      </div>

      {loading && <p>Loading…</p>}

      <table>
        <thead>
          <tr>
            <th>#</th><th>Subject</th><th>Status</th><th>Priority</th><th>SLA</th>
            <th>Assignee</th><th>Comments</th><th>Created</th><th />
          </tr>
        </thead>
        <tbody>
          {rows.map((t, i) => (
            <tr key={i}>
              <td>{t.id}</td>
              <td><Link to={`/tickets/${t.id}`}>{t.subject}</Link></td>
              <td>{t.status}</td>
              <td>{t.priority}</td>
              <td>{t.sla?.breached && <span className="badge-breached">Breached</span>}</td>
              <td>{t.assignee_name || '—'}</td>
              <td>{t.comment_count}</td>
              <td>{new Date(t.created_at).toLocaleString()}</td>
              <td>
                {user?.role === 'admin' && (
                  <button onClick={() => handleDelete(t.id)}>Delete</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="pager">
        <button disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span>Page {page} of {pageCount || 1} · {total} tickets</span>
        <button disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </div>
  );
}
