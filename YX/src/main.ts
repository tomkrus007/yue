import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHashHistory } from 'vue-router'
import App from './App.vue'
import LoginView from './views/LoginView.vue'
import ChatView from './views/ChatView.vue'
import ContactsView from './views/ContactsView.vue'
import ContactDetailView from './views/ContactDetailView.vue'
import DiskView from './views/DiskView.vue'
import AppsView from './views/AppsView.vue'
import ZtView from './views/ZtView.vue'
import WemeetView from './views/WemeetView.vue'
import { installLogCapture } from './services/app-log'
import './assets/styles.css'

// 接管 console.* 与未捕获异常，让它们都能在「更多 → 日志」窗口里看到
installLogCapture()

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/login' },
    { path: '/login', component: LoginView },
    { path: '/chat', component: ChatView, meta: { requiresAuth: true } },
    { path: '/contacts', component: ContactsView, meta: { requiresAuth: true } },
    {
      path: '/contact/:kind/:id',
      component: ContactDetailView,
      meta: { requiresAuth: true },
    },
    { path: '/disk', component: DiskView, meta: { requiresAuth: true } },
    { path: '/apps', component: AppsView, meta: { requiresAuth: true } },
    { path: '/zt', component: ZtView, meta: { requiresAuth: true } },
    { path: '/wemeet', component: WemeetView, meta: { requiresAuth: true } },
  ],
})

router.beforeEach((to) => {
  if (to.meta.requiresAuth) {
    const token = localStorage.getItem('AccessToken')
    if (!token) return '/login'
  }
})

createApp(App).use(createPinia()).use(router).mount('#app')
