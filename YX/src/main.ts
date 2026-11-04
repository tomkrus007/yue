import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHashHistory } from 'vue-router'
import App from './App.vue'
import LoginView from './views/LoginView.vue'
import ChatView from './views/ChatView.vue'
import ContactsView from './views/ContactsView.vue'
import ContactDetailView from './views/ContactDetailView.vue'
import DiskView from './views/DiskView.vue'
import ZtView from './views/ZtView.vue'
import './assets/styles.css'

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
    { path: '/zt', component: ZtView, meta: { requiresAuth: true } },
  ],
})

router.beforeEach((to) => {
  if (to.meta.requiresAuth) {
    const token = localStorage.getItem('AccessToken')
    if (!token) return '/login'
  }
})

createApp(App).use(createPinia()).use(router).mount('#app')
