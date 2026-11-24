<template>
    <div class="flex flex-col gap-10 py-2">
        <SettingsGroup :title="t('view.settings.general.general.header')">
            <div class="flex flex-col gap-0.5 px-1 py-1">
                <div class="flex-1">
                    <span class="block truncate font-medium text-sm leading-[18px]">{{
                        t('view.settings.general.general.version')
                    }}</span>
                    <span class="block truncate text-xs text-muted-foreground" v-text="appVersion"></span>
                </div>
            </div>

            <div v-if="!isWeb" class="flex flex-col gap-0.5 px-1 py-1 cursor-pointer" @click="checkForVRCXUpdate">
                <div class="flex-1">
                    <span class="block truncate font-medium text-sm leading-[18px]">{{
                        t('view.settings.general.general.latest_app_version')
                    }}</span>
                    <span
                        v-if="latestAppVersion"
                        class="block truncate text-xs text-muted-foreground"
                        v-text="latestAppVersion"></span>
                    <span v-else class="block truncate text-xs text-muted-foreground">{{
                        t('view.settings.general.general.latest_app_version_refresh')
                    }}</span>
                </div>
            </div>

            <div class="flex flex-col gap-0.5 px-1 py-1 cursor-pointer" @click="openExternalLink(links.github)">
                <div class="flex-1">
                    <span class="block truncate font-medium text-sm leading-[18px]">{{
                        t('view.settings.general.general.repository_url')
                    }}</span>
                    <span v-once class="block truncate text-xs text-muted-foreground">{{ links.github }}</span>
                </div>
            </div>

            <div
                v-if="!isWeb"
                class="flex flex-col gap-0.5 px-1 py-1 cursor-pointer"
                @click="openExternalLink(links.discord)">
                <div class="flex-1">
                    <span class="block truncate font-medium text-sm leading-[18px]">{{
                        t('view.settings.general.general.support')
                    }}</span>
                    <span v-once class="block truncate text-xs text-muted-foreground">{{ links.discord }}</span>
                </div>
            </div>

            <SettingsItem
                v-if="isWeb"
                :label="t('cloud_hub.settings.sync_interval_label')"
                :description="t('cloud_hub.settings.sync_interval_desc')">
                <Select
                    :model-value="String(cloudState.webSyncIntervalSeconds)"
                    @update:model-value="onSelectCloudSyncInterval">
                    <SelectTrigger size="sm" class="min-w-[165px]">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="60">{{ t('cloud_hub.settings.interval_60') }}</SelectItem>
                        <SelectItem value="120">{{ t('cloud_hub.settings.interval_120') }}</SelectItem>
                        <SelectItem value="300">{{ t('cloud_hub.settings.interval_300') }}</SelectItem>
                        <SelectItem value="600">{{ t('cloud_hub.settings.interval_600') }}</SelectItem>
                        <SelectItem value="900">{{ t('cloud_hub.settings.interval_900') }}</SelectItem>
                        <SelectItem value="1800">{{ t('cloud_hub.settings.interval_1800') }}</SelectItem>
                        <SelectItem value="3600">{{ t('cloud_hub.settings.interval_3600') }}</SelectItem>
                    </SelectContent>
                </Select>
            </SettingsItem>

            <SettingsItem
                v-if="isWeb"
                :label="t('cloud_hub.settings.hub_label')"
                :description="t('cloud_hub.settings.hub_desc')">
                <Button size="sm" variant="outline" @click="cloudState.hubDialogOpen = true">
                    {{ t('cloud_hub.settings.open_hub') }}
                </Button>
            </SettingsItem>
        </SettingsGroup>

        <SettingsGroup v-if="!isWeb" :title="t('view.settings.general.vrcx_updater.header')">
            <div class="flex gap-2">
                <Button size="sm" variant="outline" @click="showChangeLogDialog">{{
                    t('view.settings.general.vrcx_updater.change_log')
                }}</Button>
                <Button v-if="!noUpdater" size="sm" variant="outline" @click="showVRCXUpdateDialog()">{{
                    t('view.settings.general.vrcx_updater.change_build')
                }}</Button>
            </div>

            <template v-if="!noUpdater">
                <SettingsItem :label="t('view.settings.general.vrcx_updater.update_action')">
                    <Select :model-value="autoUpdateVRCX" @update:model-value="setAutoUpdateVRCX">
                        <SelectTrigger size="sm">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="Off">{{
                                t('view.settings.general.vrcx_updater.auto_update_off')
                            }}</SelectItem>
                            <SelectItem value="Notify">{{
                                t('view.settings.general.vrcx_updater.auto_update_notify')
                            }}</SelectItem>
                            <SelectItem value="Auto Download">{{
                                t('view.settings.general.vrcx_updater.auto_update_download')
                            }}</SelectItem>
                        </SelectContent>
                    </Select>
                </SettingsItem>
            </template>
            <div v-else class="text-sm text-muted-foreground">
                {{ t('view.settings.general.vrcx_updater.updater_disabled') }}
            </div>
        </SettingsGroup>

        <SettingsGroup v-if="!isWeb" :title="t('view.settings.general.application.header')">
            <SettingsItem v-if="!isLinux" :label="t('view.settings.general.application.startup')" toggle>
                <Switch
                    :model-value="isStartAtWindowsStartup"
                    :ariaLabel="t('view.settings.general.application.startup')"
                    @update:modelValue="setIsStartAtWindowsStartup" />
            </SettingsItem>

            <SettingsItem v-if="!isLinux" :label="t('view.settings.general.application.minimized')" toggle>
                <Switch
                    :model-value="isStartAsMinimizedState"
                    :ariaLabel="t('view.settings.general.application.minimized')"
                    @update:modelValue="setIsStartAsMinimizedState" />
            </SettingsItem>
            <SettingsItem
                v-else
                :label="t('view.settings.general.application.minimized')"
                :description="t('view.settings.general.application.startup_linux')"
                toggle>
                <Switch
                    :model-value="isStartAsMinimizedState"
                    :ariaLabel="t('view.settings.general.application.minimized')"
                    @update:modelValue="setIsStartAsMinimizedState" />
            </SettingsItem>

            <SettingsItem v-if="!isMacOS" :label="t('view.settings.general.application.tray')" toggle>
                <Switch
                    :model-value="isCloseToTray"
                    :ariaLabel="t('view.settings.general.application.tray')"
                    @update:modelValue="setIsCloseToTray" />
            </SettingsItem>

            <SettingsItem
                v-if="!isLinux"
                :label="t('view.settings.general.application.disable_gpu_acceleration')"
                :description="t('view.settings.general.application.disable_gpu_acceleration_tooltip')"
                toggle>
                <Switch
                    :model-value="disableGpuAcceleration"
                    :ariaLabel="t('view.settings.general.application.disable_gpu_acceleration')"
                    @update:modelValue="setDisableGpuAcceleration" />
            </SettingsItem>

            <SettingsItem
                v-if="!isLinux"
                :label="t('view.settings.general.application.disable_vr_overlay_gpu_acceleration')"
                :description="t('view.settings.general.application.disable_gpu_acceleration_tooltip')"
                toggle>
                <Switch
                    :model-value="disableVrOverlayGpuAcceleration"
                    :ariaLabel="t('view.settings.general.application.disable_vr_overlay_gpu_acceleration')"
                    @update:modelValue="setDisableVrOverlayGpuAcceleration" />
            </SettingsItem>

            <SettingsItem :label="t('view.settings.general.application.proxy')">
                <Button size="sm" variant="outline" @click="promptProxySettings">{{
                    t('view.settings.general.application.proxy')
                }}</Button>
            </SettingsItem>
        </SettingsGroup>

        <SettingsGroup v-if="!isWeb" :title="t('view.settings.general.contributors.header')">
            <div>
                <img
                    src="https://contrib.rocks/image?repo=vrcx-team/VRCX"
                    alt="Upstream VRCX Contributors"
                    class="cursor-pointer"
                    @click="openExternalLink('https://github.com/vrcx-team/VRCX/graphs/contributors')" />
            </div>
        </SettingsGroup>

        <SettingsGroup :title="t('view.settings.general.legal_notice.header')">
            <div class="flex flex-col gap-2 text-sm text-muted-foreground mb-2">
                <p v-if="isWeb" class="m-0">
                    {{ t('cloud_hub.settings.derivative_notice_prefix')
                    }}<a class="cursor-pointer underline" @click="openExternalLink('https://github.com/vrcx-team/VRCX')"
                        >vrcx-team/VRCX</a
                    >{{ t('cloud_hub.settings.derivative_notice_suffix') }}
                </p>
                <p class="m-0">
                    &copy; 2019-2026
                    <a class="cursor-pointer" @click="openExternalLink('https://github.com/pypy-vrc')">pypy</a> &amp;
                    <a class="cursor-pointer" @click="openExternalLink('https://github.com/Natsumi-sama')">Natsumi</a>
                    &amp;
                    <a class="cursor-pointer" @click="openExternalLink('https://github.com/Map1en')">Map1en</a>
                </p>
                <p class="m-0">{{ t('view.settings.general.legal_notice.info') }}</p>
                <p class="m-0">{{ t('view.settings.general.legal_notice.disclaimer1') }}</p>
                <p class="m-0">{{ t('view.settings.general.legal_notice.disclaimer2') }}</p>
            </div>

            <SettingsItem :label="t('view.settings.general.legal_notice.open_source_software_notice')">
                <Button size="sm" variant="outline" @click="openOSSDialog">{{
                    t('view.settings.general.legal_notice.open_source_software_notice')
                }}</Button>
            </SettingsItem>
        </SettingsGroup>

        <OpenSourceSoftwareNoticeDialog v-if="ossDialog" v-model:ossDialog="ossDialog" />
    </div>
</template>

<script setup>
    import { computed, defineAsyncComponent, ref } from 'vue';
    import { Button } from '@/components/ui/button';
    import { Switch } from '@/components/ui/switch';
    import { storeToRefs } from 'pinia';
    import { useI18n } from 'vue-i18n';

    import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
    import { toast } from 'vue-sonner';
    import { useGeneralSettingsStore, useVRCXUpdaterStore } from '@/stores';
    import { links } from '@/shared/constants';
    import { openExternalLink } from '@/shared/utils';
    import { saveWebSyncIntervalSeconds } from '@/ipc-web/bootstrapCache';
    import { cloudState } from '@/ipc-web/cloudState';

    import SettingsGroup from '../SettingsGroup.vue';
    import SettingsItem from '../SettingsItem.vue';

    const { t } = useI18n();
    const isWeb = computed(() => typeof WEB !== 'undefined' && WEB);

    const generalSettingsStore = useGeneralSettingsStore();
    const vrcxUpdaterStore = useVRCXUpdaterStore();

    const {
        isStartAtWindowsStartup,
        isStartAsMinimizedState,
        isCloseToTray,
        disableGpuAcceleration,
        disableVrOverlayGpuAcceleration
    } = storeToRefs(generalSettingsStore);

    const {
        setIsStartAtWindowsStartup,
        setIsStartAsMinimizedState,
        setIsCloseToTray,
        setDisableGpuAcceleration,
        setDisableVrOverlayGpuAcceleration,
        promptProxySettings
    } = generalSettingsStore;

    const { appVersion, autoUpdateVRCX, latestAppVersion, noUpdater } = storeToRefs(vrcxUpdaterStore);
    const { setAutoUpdateVRCX, checkForVRCXUpdate, showVRCXUpdateDialog, showChangeLogDialog } = vrcxUpdaterStore;

    const ossDialog = ref(false);
    const isLinux = computed(() => LINUX);
    const isMacOS = computed(() => {
        return navigator.platform.indexOf('Mac') > -1;
    });

    const OpenSourceSoftwareNoticeDialog = defineAsyncComponent(
        () => import('../../dialogs/OpenSourceSoftwareNoticeDialog.vue')
    );

    function openOSSDialog() {
        ossDialog.value = true;
    }

    async function onSelectCloudSyncInterval(val) {
        try {
            const saved = await saveWebSyncIntervalSeconds(val);
            toast.success(t('cloud_hub.settings.sync_interval_saved_toast', { seconds: saved }));
        } catch (err) {
            toast.error(t('cloud_hub.settings.sync_interval_failed_toast', { error: err?.message || err }));
        }
    }
</script>
