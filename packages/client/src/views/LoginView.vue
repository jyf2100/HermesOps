<script setup lang="ts">
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { setApiKey, hasApiKey } from "@/api/client";
import { fetchAuthStatus, loginWithPassword, autoLogin } from "@/api/auth";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();

const loginMode = ref<"password" | "token">("password");
const username = ref("");
const password = ref("");
const token = ref("");
const loading = ref(false);
const errorMsg = ref("");

// URL token auto-login — single entry point in setup block
const urlToken = (route.query.token as string) || new URLSearchParams(window.location.search).get('token')
if (urlToken) {
  setApiKey(urlToken)
  // Strip token from URL to prevent exposure in browser history and address bar
  const cleanUrl = new URL(window.location.href)
  cleanUrl.searchParams.delete('token')
  cleanUrl.hash = cleanUrl.hash.replace(/([?&])token=[^&]*&?/, '$1').replace(/[?&]$/, '')
  window.history.replaceState({}, '', cleanUrl.toString())
  router.replace("/hermes/chat")
} else if (hasApiKey()) {
  router.replace("/hermes/chat");
} else {
  // Try server-side auto-login when no stored credentials
  autoLogin().then(jwt => {
    setApiKey(jwt)
    router.replace("/hermes/chat")
  }).catch(() => {
    // Auto-login not available or disabled — show login form
  })
}

async function handleLogin() {
  if (loginMode.value === "token") {
    await handleTokenLogin();
  } else {
    await handlePasswordLogin();
  }
}

async function handleTokenLogin() {
  if (!token.value.trim()) {
    errorMsg.value = t("login.tokenRequired");
    return;
  }

  loading.value = true;
  errorMsg.value = "";

  try {
    setApiKey(token.value.trim());
    // Validate token against server before navigating
    await fetchAuthStatus();
    router.replace("/hermes/chat");
  } catch (err: any) {
    // Token is invalid — clear it and show error
    setApiKey("");
    if (err.status === 429 || err.status === 503) {
      errorMsg.value = t("login.tooManyAttempts");
    } else {
      errorMsg.value = err.message || t("login.invalidCredentials");
    }
  } finally {
    loading.value = false;
  }
}

async function handlePasswordLogin() {
  if (!username.value.trim() || !password.value) {
    errorMsg.value = t("login.credentialsRequired");
    return;
  }

  loading.value = true;
  errorMsg.value = "";

  try {
    const sessionToken = await loginWithPassword(username.value.trim(), password.value);
    setApiKey(sessionToken);
    router.replace("/hermes/chat");
  } catch (err: any) {
    if (err.status === 429 || err.status === 503) {
      errorMsg.value = t("login.tooManyAttempts");
    } else {
      errorMsg.value = err.message || t("login.invalidCredentials");
    }
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login-view">
    <div class="login-card">
      <div class="login-logo">
        <img src="/logo.png" alt="Hermes" width="80" height="80" />
      </div>
      <h1 class="login-title">{{ t("login.title") }}</h1>
      <p class="login-desc">{{ t("login.description") }}</p>
      <form class="login-form" @submit.prevent="handleLogin">
        <div class="login-mode-tabs">
          <button
            type="button"
            class="mode-tab"
            :class="{ active: loginMode === 'password' }"
            @click="loginMode = 'password'; errorMsg = ''"
          >{{ t('login.passwordLogin') }}</button>
          <button
            type="button"
            class="mode-tab"
            :class="{ active: loginMode === 'token' }"
            @click="loginMode = 'token'; errorMsg = ''"
          >{{ t('login.tokenLogin') }}</button>
        </div>

        <template v-if="loginMode === 'password'">
          <input
            v-model="username"
            type="text"
            class="login-input"
            :placeholder="t('login.usernamePlaceholder')"
            autofocus
          />
          <input
            v-model="password"
            type="password"
            class="login-input"
            :placeholder="t('login.passwordPlaceholder')"
            @keyup.enter="handleLogin"
          />
        </template>

        <template v-else>
          <input
            v-model="token"
            type="text"
            class="login-input"
            :placeholder="t('login.placeholder')"
            autofocus
          />
        </template>

        <div v-if="errorMsg" class="login-error">{{ errorMsg }}</div>
        <button type="submit" class="login-btn" :disabled="loading">
          {{ loading ? "..." : t("login.submit") }}
        </button>
      </form>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.login-view {
  height: calc(100 * var(--vh));
  display: flex;
  align-items: center;
  justify-content: center;
  background: $bg-primary;
}

.login-card {
  width: 480px;
  max-width: calc(100vw - 32px);
  padding: 56px;
  border: 1px solid $border-color;
  border-radius: $radius-lg;
  background: $bg-card;
  text-align: center;

  @media (max-width: $breakpoint-mobile) {
    padding: 32px 24px;
  }
}

.login-logo {
  margin-bottom: 24px;
}

.login-title {
  font-size: 26px;
  font-weight: 600;
  color: $text-primary;
  margin: 0 0 10px;
}

.login-desc {
  font-size: 14px;
  color: $text-muted;
  margin: 0 0 12px;
  line-height: 1.6;
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.login-mode-tabs {
  display: flex;
  gap: 0;
  border-radius: $radius-sm;
  overflow: hidden;
  border: 1px solid $border-color;
}

.mode-tab {
  flex: 1;
  padding: 10px;
  border: none;
  background: transparent;
  color: $text-muted;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all $transition-fast;

  &.active {
    background: $accent-primary;
    color: var(--text-on-accent);
  }

  &:hover:not(.active) {
    background: $bg-card-hover;
  }
}

.login-input {
  width: 100%;
  padding: 14px 16px;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  font-size: 15px;
  color: $text-primary;
  background: $bg-input;
  outline: none;
  transition: border-color $transition-fast;
  box-sizing: border-box;
  font-family: $font-code;

  &::placeholder {
    color: $text-muted;
  }

  &:focus {
    border-color: $accent-primary;
  }
}

.login-error {
  font-size: 13px;
  color: $error;
  text-align: left;
}

.login-btn {
  width: 100%;
  padding: 14px;
  border: none;
  border-radius: $radius-sm;
  background: $text-primary;
  color: var(--text-on-accent);
  font-size: 15px;
  font-weight: 500;
  cursor: pointer;
  transition: opacity $transition-fast;

  &:hover {
    opacity: 0.85;
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}
</style>
