<template>
    <TooltipProvider>
        <MacOSTitleBar></MacOSTitleBar>

        <div
            id="x-app"
            class="flex w-screen h-screen overflow-hidden cursor-default [&>.x-container]:pt-[15px]"
            :class="{ 'pt-7': isMacOS }">
            <RouterView></RouterView>
            <Toaster position="top-center" :theme="theme"></Toaster>

            <AlertDialogModal></AlertDialogModal>
            <OpenExternalLinkDialog></OpenExternalLinkDialog>
            <PromptDialogModal></PromptDialogModal>
            <OtpDialogModal></OtpDialogModal>
            <DatabaseUpgradeDialog></DatabaseUpgradeDialog>

            <VRCXUpdateDialog></VRCXUpdateDialog>
            <CloudGateAndHub v-if="isWeb"></CloudGateAndHub>
        </div>
        <div id="x-dialog-portal" class="x-dialog-portal"></div>
    </TooltipProvider>
</template>

<script setup>
    import { computed, onBeforeMount, onMounted } from 'vue';

    import { addGameLogEvent, getGameLogTable, tryLoadPlayerList } from './coordinators/gameLogCoordinator';
    import {
        runCheckVRChatDebugLoggingFlow,
        runUpdateCloudGameStartTimesFlow,
        runUpdateIsGameRunningFlow,
        runUpdateIsHmdAfkFlow
    } from './coordinators/gameCoordinator';
    import { watchState } from './services/watchState';
    import { Toaster } from './components/ui/sonner';
    import { TooltipProvider } from './components/ui/tooltip';
    import { createGlobalStores } from './stores';
    import { initNoty } from './plugins/noty';

    import AlertDialogModal from './components/ui/alert-dialog/AlertDialogModal.vue';
    import CloudGateAndHub from './components/cloud/CloudGateAndHub.vue';
    import DatabaseUpgradeDialog from './components/dialogs/DatabaseUpgradeDialog.vue';
    import MacOSTitleBar from './components/MacOSTitleBar.vue';
    import OpenExternalLinkDialog from './components/dialogs/OpenExternalLinkDialog.vue';
    import OtpDialogModal from './components/ui/dialog/OtpDialogModal.vue';
    import PromptDialogModal from './components/ui/dialog/PromptDialogModal.vue';
    import VRCXUpdateDialog from './components/dialogs/VRCXUpdateDialog.vue';

    import '@/styles/globals.css';

    const isWeb = typeof WEB !== 'undefined' && WEB;
    console.log(`isLinux: ${LINUX}, isWeb: ${isWeb}`);

    const isMacOS = computed(() => !isWeb && navigator.platform.includes('Mac'));

    const theme = computed(() => {
        return store.appearanceSettings.isDarkMode ? 'dark' : 'light';
    });

    initNoty();

    const store = createGlobalStores();

    const coordinatorModules = import.meta.glob('./coordinators/*.js', { eager: true });
    const coordinators = Object.fromEntries(
        Object.entries(coordinatorModules).map(([path, module]) => [
            path.replace('./coordinators/', '').replace('Coordinator.js', ''),
            module
        ])
    );

    if (typeof window !== 'undefined') {
        window.$pinia = store;
        window.$coordinators = coordinators;
        window.$bridge = {
            updateCloudGameStartTimes: runUpdateCloudGameStartTimesFlow,
            updateIsGameRunning: runUpdateIsGameRunningFlow,
            updateIsHmdAfk: runUpdateIsHmdAfkFlow,
            refreshCloudPlayerList: () => {
                if (watchState.isFriendsLoaded) {
                    tryLoadPlayerList();
                }
            },
            addGameLogEvent
        };
        if (isWeb && typeof AppApi !== 'undefined' && typeof AppApi.CheckGameRunning === 'function') {
            AppApi.CheckGameRunning();
        }
    }

    onBeforeMount(() => {
        store.updateLoop.updateLoop();
    });

    onMounted(async () => {
        if (await store.vrcx.waitForDatabaseInit()) {
            getGameLogTable();
            await store.auth.migrateStoredUsers();
            store.auth.autoLoginAfterMounted();
            if (!isWeb) {
                store.vrcx.checkAutoBackupRestoreVrcRegistry();
            }
        }

        if (!isWeb) {
            runCheckVRChatDebugLoggingFlow();
        }
    });
</script>
