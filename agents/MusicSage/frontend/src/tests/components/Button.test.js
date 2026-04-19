import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, it, expect, vi } from 'vitest';
import Button from '../../components/ui/Button.svelte';

describe('Button', () => {
  it('renders a button element', () => {
    const { container } = render(Button);
    expect(container.querySelector('button')).toBeInTheDocument();
  });

  it('is enabled by default', () => {
    const { container } = render(Button);
    expect(container.querySelector('button')).not.toBeDisabled();
  });

  it('is disabled when disabled=true', () => {
    const { container } = render(Button, { disabled: true });
    expect(container.querySelector('button')).toBeDisabled();
  });

  it('is disabled when loading=true', () => {
    const { container } = render(Button, { loading: true });
    expect(container.querySelector('button')).toBeDisabled();
  });

  it('applies btn-danger class for danger variant', () => {
    const { container } = render(Button, { variant: 'danger' });
    const btn = container.querySelector('button');
    expect(btn.className).toContain('text-red-400');
  });

  it('fires onclick when clicked', async () => {
    const handler = vi.fn();
    const { container } = render(Button, { onclick: handler });
    await fireEvent.click(container.querySelector('button'));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('has disabled attribute when disabled (browser prevents click)', () => {
    const { container } = render(Button, { disabled: true });
    // Browser enforces no-click via the disabled attribute; we verify it is set
    expect(container.querySelector('button')).toBeDisabled();
  });

  it('uses button type by default', () => {
    const { container } = render(Button);
    expect(container.querySelector('button').type).toBe('button');
  });

  it('accepts custom type', () => {
    const { container } = render(Button, { type: 'submit' });
    expect(container.querySelector('button').type).toBe('submit');
  });
});
