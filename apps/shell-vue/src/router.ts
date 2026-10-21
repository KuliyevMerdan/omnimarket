import { createRouter, createWebHistory } from 'vue-router'
import ActivityView from './views/ActivityView.vue'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/market' },
    // One record for both marketplace pages: the remote stays mounted and only gets `update()`.
    {
      path: '/:page(market|nfts|inspect)',
      name: 'market',
      component: () => import('./views/MarketView.vue'),
      props: (route) => ({ page: route.params.page === 'nfts' ? 'mine' : route.params.page === 'inspect' ? 'inspect' : 'market' }),
    },
    { path: '/activity', name: 'activity', component: ActivityView },
  ],
})
