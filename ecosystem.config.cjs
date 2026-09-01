module.exports = {
  apps: [{
    name: "notify",
    cwd: "/root/notify",
    script: "dist/server.js",
    exec_mode: "fork",
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: "500M",
    env: {
      NODE_ENV: "production"
    },
    error_file: "/root/.pm2/logs/notify-error.log",
    out_file: "/root/.pm2/logs/notify-out.log",
    log_date_format: "YYYY-MM-DD HH:mm:ss Z"
  }]
};
