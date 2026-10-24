import { useState, type FormEvent } from 'react';
import { useMutation } from '@apollo/client';
import { graphql } from '../gql';
import { setToken } from '../lib/auth';
import { errorText } from '../lib/errors';

const LOGIN = graphql(`
  mutation Login($input: LoginInput!) {
    login(input: $input) {
      token
      user {
        id
        name
      }
    }
  }
`);

const SIGN_UP = graphql(`
  mutation SignUp($input: SignUpInput!) {
    signUp(input: $input) {
      token
      user {
        id
        name
      }
    }
  }
`);

export function LoginPage() {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [login, { loading: loggingIn }] = useMutation(LOGIN);
  const [signUp, { loading: signingUp }] = useMutation(SIGN_UP);
  const busy = loggingIn || signingUp;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const token =
        mode === 'login'
          ? (await login({ variables: { input: { email, password } } })).data?.login.token
          : (await signUp({ variables: { input: { name, email, password } } })).data?.signUp.token;
      if (!token) return;
      setToken(token);
      // A full reload resets the Apollo cache and the WebSocket, so nothing from a previous
      // session (or its permissions) can survive a user switch.
      location.assign('/');
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <div className="logo">
          <span className="logo-mark">✓</span> TaskFlow
        </div>
        <h1>{mode === 'login' ? 'Sign in' : 'Create your account'}</h1>
        {mode === 'signup' && (
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
          </label>
        )}
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={mode === 'signup' ? 8 : undefined}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Sign up'}
        </button>
        <button type="button" className="link" onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}>
          {mode === 'login' ? 'Need an account? Sign up' : 'Have an account? Sign in'}
        </button>
        {mode === 'login' && (
          <p className="hint">
            Demo: <code>ada@taskflow.dev</code> / <code>password123</code> (owner), <code>grace@…</code> (admin), <code>linus@…</code> (member)
          </p>
        )}
      </form>
    </div>
  );
}
