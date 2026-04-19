/**
 * user.js — store para seleção de usuário Plex
 * Permite filtrar insights/métricas por conta do Plex.
 */
import { writable } from 'svelte/store';

/** Lista de usuários carregados da API [ {id, name, thumb} ] */
export const users = writable([]);

/** ID do usuário selecionado (null = todos os usuários) */
export const selectedUserId = writable(null);
