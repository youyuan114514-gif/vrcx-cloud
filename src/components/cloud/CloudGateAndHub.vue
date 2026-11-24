<template>
    <!-- 1. Cloud Access / Passcode Unlock Overlay (only when ADMIN_PASSCODE is set and unauthenticated) -->
    <div
        v-if="isWeb && cloudState.initialized && !cloudState.authenticated"
        class="fixed inset-0 z-[9999] flex items-center justify-center bg-background/95 backdrop-blur-sm p-4">
        <div class="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-2xl space-y-4">
            <div class="space-y-1">
                <h2 class="text-lg font-semibold text-foreground">{{ t('cloud_hub.unlock.title') }}</h2>
                <p class="text-xs text-muted-foreground">
                    <template v-if="cloudState.authMode === 'cloudflare_access'">
                        {{ t('cloud_hub.unlock.cf_access_desc') }}
                    </template>
                    <template v-else-if="cloudState.requiresTotp">
                        {{ t('cloud_hub.unlock.passcode_totp_desc') }}
                    </template>
                    <template v-else>
                        {{ t('cloud_hub.unlock.passcode_desc') }}
                    </template>
                </p>
            </div>

            <form v-if="cloudState.authMode !== 'cloudflare_access'" class="space-y-3" @submit.prevent="submitUnlock">
                <input
                    v-model="passcode"
                    type="password"
                    autocomplete="current-password"
                    :placeholder="t('cloud_hub.unlock.passcode_placeholder')"
                    class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                    required />
                <input
                    v-if="cloudState.requiresTotp"
                    v-model="totpCode"
                    type="text"
                    inputmode="numeric"
                    maxlength="6"
                    :placeholder="t('cloud_hub.unlock.totp_placeholder')"
                    class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                    required />
                <p v-if="unlockError" class="text-xs text-destructive">{{ unlockError }}</p>
                <button
                    type="submit"
                    :disabled="unlocking"
                    class="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
                    {{ unlocking ? t('cloud_hub.unlock.verifying') : t('cloud_hub.unlock.submit') }}
                </button>
            </form>
        </div>
    </div>

    <!-- 2. VRCX Cloud Hub Modal (HTTP Sync, Remote Commands, Free-Tier Quota & WAF Probe) -->
    <div
        v-if="isWeb && cloudState.hubDialogOpen"
        class="fixed inset-0 z-[9990] flex items-center justify-center bg-black/60 backdrop-blur-xs p-3">
        <div
            class="flex max-h-[86vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-card text-foreground shadow-2xl">
            <div class="flex items-center justify-between border-b border-border px-5 py-3.5">
                <div class="flex items-center gap-2.5">
                    <span
                        class="inline-block size-2.5 rounded-full"
                        :class="
                            cloudState.agentsOnline.length > 0 || recentSyncedCount > 0
                                ? 'bg-status-online'
                                : 'bg-status-offline-alt'
                        " />
                    <h2 class="text-sm font-semibold">{{ t('cloud_hub.title') }}</h2>
                    <span class="rounded bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                        <template v-if="cloudState.agentsOnline.length > 0">
                            {{ t('cloud_hub.agent_online', { count: cloudState.agentsOnline.length }) }}
                        </template>
                        <template v-else-if="recentSyncedCount > 0">
                            {{ t('cloud_hub.agent_synced', { count: recentSyncedCount }) }}
                        </template>
                        <template v-else>{{ t('cloud_hub.agent_idle') }}</template>
                    </span>
                </div>
                <button
                    type="button"
                    class="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                    @click="cloudState.hubDialogOpen = false">
                    {{ t('cloud_hub.close') }}
                </button>
            </div>

            <!-- Tabs -->
            <div class="flex gap-1 border-b border-border px-4 pt-2 text-xs">
                <button
                    v-for="tab in tabs"
                    :key="tab.id"
                    type="button"
                    class="rounded-t-md px-3 py-2 font-medium transition-colors"
                    :class="
                        activeTab === tab.id
                            ? 'border-b-2 border-primary text-foreground'
                            : 'text-muted-foreground hover:text-foreground'
                    "
                    @click="selectTab(tab.id)">
                    {{ tab.label }}
                </button>
            </div>

            <div class="flex-1 overflow-y-auto p-5 text-xs space-y-4">
                <!-- Tab 1: Windows Agent Periodic HTTP Sync (URL + Sync Secret) -->
                <div v-if="activeTab === 'devices'" class="space-y-4">
                    <div class="rounded-lg border border-border bg-background/50 p-4 space-y-3">
                        <div class="space-y-2">
                            <div>
                                <div class="font-medium text-foreground">{{ t('cloud_hub.devices.heading') }}</div>
                                <div class="text-muted-foreground">
                                    {{ t('cloud_hub.devices.desc') }}
                                </div>
                            </div>
                            <div class="flex flex-wrap items-center gap-2">
                                <a
                                    :href="links.agentDownload"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    class="inline-flex items-center rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground hover:opacity-90">
                                    {{ t('cloud_hub.devices.download_release_btn') }}
                                </a>
                                <a
                                    :href="links.agentGuide"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    class="inline-flex items-center rounded-md border border-border px-3 py-1.5 font-medium text-foreground hover:bg-accent">
                                    {{ t('cloud_hub.devices.download_guide_btn') }}
                                </a>
                            </div>
                        </div>

                        <div class="space-y-1">
                            <div class="text-[11px] font-medium text-muted-foreground">
                                {{ t('cloud_hub.devices.cloud_url') }}
                            </div>
                            <div class="flex items-center gap-2">
                                <input
                                    :value="cloudOriginUrl"
                                    type="text"
                                    readonly
                                    class="flex-1 rounded-md border border-input bg-muted/40 px-3 py-1.5 font-mono text-xs text-foreground" />
                                <button
                                    type="button"
                                    class="rounded-md border border-border px-3 py-1.5 font-medium hover:bg-accent"
                                    @click="copyText(cloudOriginUrl, 'url')">
                                    {{
                                        copiedField === 'url'
                                            ? t('cloud_hub.devices.copied')
                                            : t('cloud_hub.devices.copy_url')
                                    }}
                                </button>
                            </div>
                        </div>

                        <div class="space-y-1.5 pt-1">
                            <div class="text-[11px] font-medium text-muted-foreground">
                                {{ t('cloud_hub.devices.create_secret_label') }}
                            </div>
                            <div class="flex flex-wrap items-center gap-2">
                                <input
                                    v-model="newDeviceName"
                                    type="text"
                                    maxlength="64"
                                    :placeholder="t('cloud_hub.devices.device_name_placeholder')"
                                    class="min-w-[180px] flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-xs text-foreground" />
                                <button
                                    type="button"
                                    class="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground"
                                    @click="createSyncSecret">
                                    {{ t('cloud_hub.devices.create_secret_btn') }}
                                </button>
                            </div>
                        </div>

                        <div
                            v-if="createdSyncKey"
                            class="space-y-1.5 rounded-md border border-primary/30 bg-muted/60 p-3">
                            <div class="flex items-center justify-between gap-2">
                                <span class="font-medium text-foreground">
                                    {{ t('cloud_hub.devices.secret_created_for', { deviceName: createdDeviceName }) }}
                                </span>
                                <button
                                    type="button"
                                    class="rounded bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground"
                                    @click="copyText(createdSyncKey, 'secret')">
                                    {{
                                        copiedField === 'secret'
                                            ? t('cloud_hub.devices.copied')
                                            : t('cloud_hub.devices.copy_secret')
                                    }}
                                </button>
                            </div>
                            <div
                                class="break-all rounded bg-background/80 px-2.5 py-1.5 font-mono text-[11px] text-primary">
                                {{ createdSyncKey }}
                            </div>
                        </div>

                        <div class="space-y-1.5 pt-1">
                            <div class="text-[11px] font-medium text-muted-foreground">
                                {{ t('cloud_hub.devices.sync_interval_label') }}
                            </div>
                            <div class="flex flex-wrap items-center gap-2">
                                <input
                                    v-model.number="syncIntervalInput"
                                    type="number"
                                    min="30"
                                    max="3600"
                                    step="30"
                                    class="w-28 rounded-md border border-input bg-background px-3 py-1.5 font-mono text-xs text-foreground" />
                                <button
                                    type="button"
                                    class="rounded-md border border-border px-3 py-1.5 font-medium hover:bg-accent"
                                    :disabled="savingSyncInterval"
                                    @click="saveSyncInterval">
                                    {{
                                        savingSyncInterval
                                            ? t('cloud_hub.devices.saving')
                                            : t('cloud_hub.devices.save_interval')
                                    }}
                                </button>
                                <span v-if="syncIntervalNotice" class="text-[11px] text-primary">
                                    {{ syncIntervalNotice }}
                                </span>
                                <span v-else class="text-[11px] text-muted-foreground">
                                    {{ t('cloud_hub.devices.sync_interval_hint') }}
                                </span>
                            </div>
                        </div>

                        <div class="text-[11px] text-muted-foreground">
                            {{ t('cloud_hub.devices.static_secret_tip_prefix')
                            }}<code class="font-mono">AGENT_SYNC_KEY</code
                            >{{ t('cloud_hub.devices.static_secret_tip_suffix') }}
                        </div>
                    </div>
                </div>

                <!-- Tab 2: Synced Devices -->
                <div v-if="activeTab === 'synced_devices'" class="space-y-4">
                    <div class="space-y-2">
                        <div class="font-medium text-foreground">
                            {{ t('cloud_hub.devices.configured_list', { count: devices.length }) }}
                        </div>
                        <div
                            v-if="devices.length === 0"
                            class="rounded-lg border border-dashed border-border p-4 text-muted-foreground">
                            {{ t('cloud_hub.devices.empty_devices') }}
                        </div>
                        <div
                            v-for="dev in devices"
                            :key="dev.device_id"
                            class="flex items-center justify-between rounded-lg border border-border p-3">
                            <div class="space-y-0.5">
                                <div class="flex items-center gap-2 font-medium">
                                    <span
                                        class="inline-block size-2 rounded-full"
                                        :class="
                                            isRecentlySynced(dev.last_seen_at)
                                                ? 'bg-status-online'
                                                : 'bg-status-offline-alt'
                                        " />
                                    <span>{{ dev.device_name }}</span>
                                    <span class="font-mono text-[11px] text-muted-foreground">{{ dev.device_id }}</span>
                                </div>
                                <div class="text-muted-foreground">
                                    v{{ dev.agent_version || '1.1.0' }} ·
                                    {{
                                        t('cloud_hub.devices.last_sync', {
                                            time: dev.last_seen_at || t('cloud_hub.devices.never_synced')
                                        })
                                    }}
                                </div>
                            </div>
                            <button
                                type="button"
                                class="rounded border border-destructive/40 px-2.5 py-1 text-destructive hover:bg-destructive/10"
                                @click="revokeDevice(dev.device_id)">
                                {{ t('cloud_hub.devices.revoke') }}
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Tab 2: Remote Commands -->
                <div v-if="activeTab === 'commands'" class="space-y-4">
                    <div class="rounded-lg border border-border bg-background/50 p-4 space-y-3">
                        <div class="font-medium text-foreground">{{ t('cloud_hub.commands.launch_heading') }}</div>
                        <div class="flex flex-wrap gap-2">
                            <input
                                v-model="launchUrlInput"
                                type="text"
                                placeholder="vrchat://launch?id=wrld_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx:12345"
                                class="min-w-[240px] flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-xs" />
                            <button
                                type="button"
                                class="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground"
                                @click="sendCommand('launch_vrc', { launchUrl: launchUrlInput })">
                                {{ t('cloud_hub.commands.launch_btn') }}
                            </button>
                        </div>
                        <div class="flex flex-wrap gap-2 pt-1">
                            <button
                                type="button"
                                class="rounded-md border border-border px-3 py-1.5 hover:bg-accent"
                                @click="sendCommand('clear_cache', { scope: 'all' })">
                                {{ t('cloud_hub.commands.clear_cache') }}
                            </button>
                            <button
                                type="button"
                                class="rounded-md border border-border px-3 py-1.5 hover:bg-accent"
                                @click="
                                    sendCommand('send_vr_notify', {
                                        target: 'xsoverlay',
                                        title: t('cloud_hub.mobile_title'),
                                        content: t('cloud_hub.commands.test_vr_notify_content')
                                    })
                                ">
                                {{ t('cloud_hub.commands.test_vr_notify') }}
                            </button>
                            <button
                                type="button"
                                class="rounded-md border border-destructive/40 px-3 py-1.5 text-destructive hover:bg-destructive/10"
                                @click="sendCommand('quit_vrc', {})">
                                {{ t('cloud_hub.commands.quit_vrc') }}
                            </button>
                        </div>
                        <p v-if="commandNotice" class="text-muted-foreground">{{ commandNotice }}</p>
                    </div>

                    <div class="space-y-1.5">
                        <div class="font-medium text-foreground">{{ t('cloud_hub.commands.history_heading') }}</div>
                        <div
                            v-for="cmd in commandHistory"
                            :key="cmd.cmd_id"
                            class="flex items-center justify-between rounded border border-border px-3 py-2">
                            <div>
                                <span class="font-mono font-semibold">{{ cmd.action }}</span>
                                <span class="ml-2 text-muted-foreground">{{ cmd.created_at }}</span>
                            </div>
                            <span class="rounded bg-muted px-2 py-0.5 font-mono uppercase">{{ cmd.status }}</span>
                        </div>
                    </div>
                </div>

                <!-- Tab 3: Free-Tier Quota & VRChat WAF Diagnostics -->
                <div v-if="activeTab === 'quota'" class="space-y-4">
                    <div v-if="quotaInfo" class="grid grid-cols-1 gap-3 sm:grid-cols-3">
                        <div
                            v-for="(info, key) in quotaInfo.databases"
                            :key="key"
                            class="rounded-lg border border-border p-3 space-y-1">
                            <div class="font-mono font-semibold uppercase">DB_{{ key }}</div>
                            <div class="text-sm font-bold">{{ formatBytes(info.bytes) }} / 500 MB</div>
                            <div class="h-1.5 w-full overflow-hidden rounded bg-muted">
                                <div
                                    class="h-full bg-primary"
                                    :style="{ width: Math.min(100, info.percentOfFreeLimit) + '%' }" />
                            </div>
                            <div class="text-[11px] text-muted-foreground">
                                {{ t('cloud_hub.quota.shard_percent', { percent: info.percentOfFreeLimit }) }}
                            </div>
                        </div>
                    </div>

                    <div class="rounded-lg border border-border bg-background/50 p-4 space-y-2">
                        <div class="flex items-center justify-between">
                            <div>
                                <div class="font-medium text-foreground">{{ t('cloud_hub.quota.probe_heading') }}</div>
                                <div class="text-muted-foreground">
                                    {{ t('cloud_hub.quota.probe_desc_prefix')
                                    }}<span class="font-mono">{{
                                        cloudState.lastVrcRoute || t('cloud_hub.quota.route_idle')
                                    }}</span
                                    >{{ t('cloud_hub.quota.probe_desc_suffix') }}
                                </div>
                            </div>
                            <button
                                type="button"
                                class="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground"
                                @click="runWafProbe">
                                {{ t('cloud_hub.quota.run_probe') }}
                            </button>
                        </div>
                        <pre
                            v-if="wafProbeResult"
                            class="overflow-x-auto rounded bg-muted/60 p-2.5 font-mono text-[11px]"
                            >{{ wafProbeResult }}</pre>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<script setup>
    import { computed, ref, watch } from 'vue';
    import { useI18n } from 'vue-i18n';
    import { cloudFetch, connectCloudHubWs } from '../../ipc-web/apiClient';
    import { loadBootstrap, saveCloudSyncIntervalSeconds } from '../../ipc-web/bootstrapCache';
    import { applyCloudPresenceUpdate, cloudState, getAgentOnlineWindowMs } from '../../ipc-web/cloudState';
    import { links } from '../../shared/constants/link';

    const { t } = useI18n();
    const isWeb = typeof WEB !== 'undefined' && WEB;
    const cloudOriginUrl = typeof window !== 'undefined' ? window.location.origin : '';

    const passcode = ref('');
    const totpCode = ref('');
    const unlockError = ref('');
    const unlocking = ref(false);

    const tabs = computed(() => [
        { id: 'devices', label: t('cloud_hub.tabs.devices') },
        { id: 'synced_devices', label: t('cloud_hub.tabs.synced_devices') },
        { id: 'commands', label: t('cloud_hub.tabs.commands') },
        { id: 'quota', label: t('cloud_hub.tabs.quota') }
    ]);
    const activeTab = ref('devices');

    const newDeviceName = ref('');
    const createdSyncKey = ref('');
    const createdDeviceName = ref('');
    const copiedField = ref('');
    const syncIntervalInput = ref(cloudState.syncIntervalSeconds || 60);
    const savingSyncInterval = ref(false);
    const syncIntervalNotice = ref('');
    const devices = ref([]);
    const launchUrlInput = ref('');
    const commandNotice = ref('');
    const commandHistory = ref([]);
    const quotaInfo = ref(null);
    const wafProbeResult = ref('');

    watch(
        () => cloudState.syncIntervalSeconds,
        (val) => {
            syncIntervalInput.value = val || 60;
        }
    );

    async function saveSyncInterval() {
        savingSyncInterval.value = true;
        syncIntervalNotice.value = '';
        try {
            const saved = await saveCloudSyncIntervalSeconds(syncIntervalInput.value);
            syncIntervalInput.value = saved;
            syncIntervalNotice.value = t('cloud_hub.devices.saved_interval', { seconds: saved });
            setTimeout(() => {
                syncIntervalNotice.value = '';
            }, 3000);
        } catch (err) {
            syncIntervalNotice.value = t('cloud_hub.devices.save_failed', { error: err?.message || err });
        } finally {
            savingSyncInterval.value = false;
        }
    }

    const recentSyncedCount = computed(() => devices.value.filter((d) => isRecentlySynced(d.last_seen_at)).length);

    function isRecentlySynced(lastSeenIso) {
        if (!lastSeenIso) return false;
        const ts = Date.parse(lastSeenIso);
        return Number.isFinite(ts) && Date.now() - ts <= getAgentOnlineWindowMs();
    }

    async function copyText(text, field) {
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
            copiedField.value = field;
            setTimeout(() => {
                if (copiedField.value === field) copiedField.value = '';
            }, 2000);
        } catch {
            // Clipboard permission unavailable
        }
    }

    async function submitUnlock() {
        unlockError.value = '';
        unlocking.value = true;
        try {
            await cloudFetch('/api/auth/login', {
                method: 'POST',
                json: { passcode: passcode.value, totp: totpCode.value || undefined }
            });
            cloudState.authenticated = true;
            await loadBootstrap();
            connectCloudHubWs();
            window.location.reload();
        } catch (err) {
            unlockError.value = err?.message || t('cloud_hub.unlock.failed');
        } finally {
            unlocking.value = false;
        }
    }

    function formatBytes(bytes) {
        const n = Number(bytes || 0);
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
        return `${(n / (1024 * 1024)).toFixed(2)} MB`;
    }

    async function loadDevices() {
        const list = await cloudFetch('/api/agent/devices').catch(() => []);
        devices.value = list;
        const deviceLastSeen = {};
        for (const dev of list) {
            if (dev?.device_id && dev?.last_seen_at) {
                const ts = Date.parse(dev.last_seen_at);
                if (Number.isFinite(ts)) {
                    deviceLastSeen[dev.device_id] = ts;
                }
            }
        }
        applyCloudPresenceUpdate({ deviceLastSeen, replaceDeviceMap: true });
    }

    async function createSyncSecret() {
        const name = (newDeviceName.value || '').trim() || t('cloud_hub.devices.default_device_name');
        const data = await cloudFetch('/api/agent/sync-key', {
            method: 'POST',
            json: { deviceName: name }
        });
        createdSyncKey.value = data.syncKey;
        createdDeviceName.value = data.deviceName || name;
        await loadDevices();
    }

    async function revokeDevice(deviceId) {
        await cloudFetch(`/api/agent/devices?deviceId=${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
        await loadDevices();
    }

    async function loadCommands() {
        commandHistory.value = await cloudFetch('/api/commands?limit=25').catch(() => []);
    }

    async function sendCommand(action, params) {
        commandNotice.value = t('cloud_hub.commands.sending', { action });
        try {
            const res = await cloudFetch('/api/commands', {
                method: 'POST',
                json: { action, params }
            });
            commandNotice.value =
                res.status === 'queued'
                    ? t('cloud_hub.commands.queued', { action, cmdId: res.cmdId })
                    : t('cloud_hub.commands.dispatched', { action, cmdId: res.cmdId });
        } catch (err) {
            commandNotice.value = t('cloud_hub.commands.failed', {
                error: err?.message || t('cloud_hub.commands.unknown_error')
            });
        }
        await loadCommands();
    }

    async function loadQuota() {
        quotaInfo.value = await cloudFetch('/api/admin/quota').catch(() => null);
    }

    async function runWafProbe() {
        wafProbeResult.value = t('cloud_hub.quota.probing');
        try {
            const res = await cloudFetch('/poc/vrc-probe');
            wafProbeResult.value = JSON.stringify(res, null, 2);
        } catch (err) {
            wafProbeResult.value = t('cloud_hub.quota.probe_error', { error: err?.message || err });
        }
    }

    function selectTab(id) {
        activeTab.value = id;
        if (id === 'devices' || id === 'synced_devices') loadDevices();
        else if (id === 'commands') loadCommands();
        else if (id === 'quota') loadQuota();
    }

    watch(
        () => cloudState.hubDialogOpen,
        (open) => {
            if (open) {
                selectTab(activeTab.value);
            }
        }
    );
</script>
