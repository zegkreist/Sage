import { render, screen } from '@testing-library/svelte';
import { describe, it, expect } from 'vitest';
import TrackRow from '../../components/data/TrackRow.svelte';
import DataTable from '../../components/data/DataTable.svelte';

describe('TrackRow', () => {
  it('renders track title', () => {
    render(TrackRow, { title: 'Paranoid Android', artist: 'Radiohead' });
    expect(screen.getByText('Paranoid Android')).toBeInTheDocument();
  });

  it('renders artist name', () => {
    render(TrackRow, { title: 'T', artist: 'Radiohead' });
    expect(screen.getByText(/Radiohead/)).toBeInTheDocument();
  });

  it('renders album when provided', () => {
    render(TrackRow, { title: 'T', artist: 'A', album: 'OK Computer' });
    expect(screen.getByText(/OK Computer/)).toBeInTheDocument();
  });

  it('renders playCount when > 0', () => {
    render(TrackRow, { title: 'T', artist: 'A', playCount: 12 });
    expect(screen.getByText('12×')).toBeInTheDocument();
  });

  it('shows — for missing title', () => {
    render(TrackRow, { artist: 'A' });
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});

describe('DataTable', () => {
  const columns = [
    { key: 'name', label: 'Name' },
    { key: 'count', label: 'Count' },
  ];

  it('renders column headers', () => {
    render(DataTable, { columns, rows: [] });
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Count')).toBeInTheDocument();
  });

  it('renders row data', () => {
    render(DataTable, {
      columns,
      rows: [{ name: 'Radiohead', count: 42 }],
    });
    expect(screen.getByText('Radiohead')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('renders empty message when no rows', () => {
    render(DataTable, { columns, rows: [], emptyMessage: 'No data found' });
    expect(screen.getByText('No data found')).toBeInTheDocument();
  });

  it('renders — for null values', () => {
    render(DataTable, {
      columns,
      rows: [{ name: 'X', count: null }],
    });
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
