import { render, screen } from '@testing-library/svelte';
import { describe, it, expect } from 'vitest';
import Card from '../../components/ui/Card.svelte';
import StatCard from '../../components/ui/StatCard.svelte';
import Badge from '../../components/ui/Badge.svelte';
import MoodBar from '../../components/ui/MoodBar.svelte';
import Alert from '../../components/ui/Alert.svelte';

describe('Card', () => {
  it('renders title when provided', () => {
    render(Card, { title: 'My Card' });
    expect(screen.getByText('My Card')).toBeInTheDocument();
  });

  it('renders subtitle when provided', () => {
    render(Card, { title: 'T', subtitle: 'Sub text' });
    expect(screen.getByText('Sub text')).toBeInTheDocument();
  });

  it('renders without title', () => {
    const { container } = render(Card);
    expect(container.querySelector('div')).toBeInTheDocument();
  });
});

describe('StatCard', () => {
  it('renders label and value', () => {
    render(StatCard, { label: 'Artists', value: '42' });
    expect(screen.getByText('Artists')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('renders icon when provided', () => {
    render(StatCard, { label: 'A', value: '1', icon: '🎵' });
    expect(screen.getByText('🎵')).toBeInTheDocument();
  });

  it('renders positive delta', () => {
    render(StatCard, { label: 'A', value: '1', delta: 5 });
    expect(screen.getByText('+5 vs mês passado')).toBeInTheDocument();
  });

  it('renders negative delta', () => {
    render(StatCard, { label: 'A', value: '1', delta: -3 });
    expect(screen.getByText('-3 vs mês passado')).toBeInTheDocument();
  });
});

describe('Badge', () => {
  it('renders children text', () => {
    const { container } = render(Badge);
    expect(container.querySelector('span')).toBeInTheDocument();
  });

  it('applies accent variant class', () => {
    const { container } = render(Badge, { variant: 'accent' });
    expect(container.querySelector('span').className).toContain('text-accent');
  });

  it('applies danger variant class', () => {
    const { container } = render(Badge, { variant: 'danger' });
    expect(container.querySelector('span').className).toContain('text-red-400');
  });
});

describe('MoodBar', () => {
  it('renders label', () => {
    render(MoodBar, { label: 'Energy', value: 7 });
    expect(screen.getByText('Energy')).toBeInTheDocument();
  });

  it('renders numeric value', () => {
    render(MoodBar, { label: 'E', value: 7 });
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  it('applies green bar for value >= 7', () => {
    const { container } = render(MoodBar, { label: 'E', value: 8 });
    const bar = container.querySelector('.bg-emerald-500');
    expect(bar).toBeTruthy();
  });
});

describe('Alert', () => {
  it('renders message', () => {
    render(Alert, { type: 'info', message: 'Test message' });
    expect(screen.getByText('Test message')).toBeInTheDocument();
  });

  it('renders nothing when message is empty', () => {
    const { container } = render(Alert, { message: '' });
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('renders dismiss button when onDismiss provided', () => {
    render(Alert, { message: 'Msg', type: 'info', onDismiss: () => {} });
    expect(screen.getByLabelText('Fechar')).toBeInTheDocument();
  });
});
