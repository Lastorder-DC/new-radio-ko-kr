<template>
  <ScreenshotLayout :header="$t('screenshots.headers.splatfest')">
    <div v-if="festival" class="grow flex items-center justify-center">
      <div class="flex space-x-32 items-center mx-6">
        <SplatfestBox
          :festival="festival"
          class="flex-1 max-w-md md:-rotate-1 scale-[1.2]"
        />

        <SplatfestResultsBox
          v-if="festival.hasResults"
          :festival="festival"
          class="max-w-md md:rotate-1 scale-[1.2]"
        />
      </div>
    </div>
  </ScreenshotLayout>
</template>

<script setup>
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import ScreenshotLayout from '@/layouts/ScreenshotLayout.vue';

import { useUSSplatfestsStore, useEUSplatfestsStore, useJPSplatfestsStore, useAPSplatfestsStore } from '@/stores/splatfests';
import SplatfestBox from '@/components/SplatfestBox.vue';
import SplatfestResultsBox from '@/components/SplatfestResultsBox.vue';

const usSplatfests = useUSSplatfestsStore();
const euSplatfests = useEUSplatfestsStore();
const jpSplatfests = useJPSplatfestsStore();
const apSplatfests = useAPSplatfestsStore();

const props = defineProps({
  region: String,
});


const route = useRoute();
const festival = computed(() => {
  let store;
  switch(props.region) {
    case 'NA': store = usSplatfests; break;
    case 'EU': store = euSplatfests; break;
    case 'JP': store = jpSplatfests; break;
    case 'AP': store = apSplatfests; break;
    default: return null;
  }
  if (route.query.festivalId) return store.festivals.find(festival => festival.__splatoon3ink_id === route.query.festivalId);
  return store.activeFestival ?? store.upcomingFestival ?? store.recentFestival;
});
</script>
