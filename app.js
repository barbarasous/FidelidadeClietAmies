/**
 * Amies Studio Beauty - Sistema de Fidelidade
 * Lógica do aplicativo, com armazenamento em nuvem (Supabase) e controle de telas.
 */

// ==========================================================================
// 1. INICIALIZAÇÃO E BANCO DE DADOS EM NUVEM (Supabase)
// ==========================================================================

// Mesmo projeto Supabase usado na Agenda, porém numa TABELA SEPARADA
// (fidelidade_store), para não interferir nos dados de produção da agenda.
const AMIES_SUPABASE_URL = "https://jlpepmznphaqeepnkjuv.supabase.co";
const AMIES_SUPABASE_KEY = "sb_publishable_9eZIAJP5Il1QYBBUJW1Szg_BKxAc25v";
const FIDELIDADE_TABLE = "fidelidade_store";
const FIDELIDADE_KEY = "loyalty-db";

// Dados semente padrões, usados apenas na primeiríssima vez (tabela vazia)
const defaultDB = {
    users: [
        {
            id: 'admin_mestre',
            name: 'Recepção Amies',
            phone: '11979691173',
            username: 'recepcao_adm',
            password: '123456',
            role: 'master'
        }
    ]
};

// Gera um "slug" de usuário a partir do nome (sem acentos, minúsculo, com pontos)
function generateUsernameSlug(name) {
    const base = (name || 'cliente')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\s]/g, '')
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .join('.');
    return base || ('cliente' + Math.floor(Math.random() * 1000));
}

// Garante que todo usuário tenha username/cashbackLedger/termsAccepted, mesmo em bases antigas
async function migrateDB(db) {
    let changed = false;
    const usedUsernames = new Set();
    db.users.forEach(u => {
        if (!u.username) {
            let candidate = generateUsernameSlug(u.name);
            let finalCandidate = candidate;
            let suffix = 1;
            while (usedUsernames.has(finalCandidate) || db.users.some(other => other !== u && other.username === finalCandidate)) {
                suffix += 1;
                finalCandidate = candidate + suffix;
            }
            u.username = finalCandidate;
            changed = true;
        }
        usedUsernames.add(u.username);

        if (u.role === 'client') {
            if (!Array.isArray(u.cashbackLedger)) {
                let running = 0;
                u.cashbackLedger = (u.history || []).map(h => {
                    running += (h.cashback || 0);
                    return { date: h.date, type: 'credit', amount: h.cashback || 0, description: `Cashback - ${h.procedure}`, balanceAfter: running };
                });
                changed = true;
            }
        }
        if (typeof u.termsAccepted === 'undefined') {
            u.termsAccepted = false;
            changed = true;
        }
    });
    if (changed) await saveDB(db);
    return db;
}

// Carrega o banco de dados da nuvem (Supabase). Se ainda não existir, semeia com o padrão.
async function getDB() {
    try {
        if (AMIES_SUPABASE_URL.includes('COLE_AQUI') || AMIES_SUPABASE_KEY.includes('COLE_AQUI')) {
            throw new Error('CONFIG_PENDENTE: cole a URL e a chave do Supabase no início do arquivo app.js.');
        }
        const res = await fetch(`${AMIES_SUPABASE_URL}/rest/v1/${FIDELIDADE_TABLE}?key=eq.${FIDELIDADE_KEY}&select=value`, {
            headers: { apikey: AMIES_SUPABASE_KEY, Authorization: `Bearer ${AMIES_SUPABASE_KEY}` }
        });
        if (!res.ok) throw new Error('Não foi possível carregar os dados da nuvem. Verifique sua internet.');
        const rows = await res.json();
        if (rows.length === 0) {
            await saveDB(defaultDB);
            return JSON.parse(JSON.stringify(defaultDB));
        }
        return await migrateDB(JSON.parse(rows[0].value));
    } catch (err) {
        showToast(err.message || 'Erro ao conectar com o banco de dados na nuvem.', 'error');
        throw err;
    }
}

// Salva o banco de dados inteiro na nuvem (Supabase)
async function saveDB(db) {
    const res = await fetch(`${AMIES_SUPABASE_URL}/rest/v1/${FIDELIDADE_TABLE}`, {
        method: 'POST',
        headers: {
            apikey: AMIES_SUPABASE_KEY,
            Authorization: `Bearer ${AMIES_SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates'
        },
        body: JSON.stringify({ key: FIDELIDADE_KEY, value: JSON.stringify(db) })
    });
    if (!res.ok) throw new Error('Não foi possível salvar os dados na nuvem. Verifique sua internet.');
}

// Evita XSS: nunca insira texto vindo do usuário direto no HTML sem escapar
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}

// Estado em memória (carregado de forma assíncrona no boot, ver seção 8)
let appDB = null;
let currentUser = JSON.parse(sessionStorage.getItem('amies_session_user')) || null;
let tempSignupData = null; // Guarda os dados do formulário de cadastro temporariamente antes do SMS
let currentSmsCode = '';   // Código SMS ativo gerado para o cadastro atual

// ==========================================================================
// 2. UTILITÁRIOS E FORMATAÇÕES
// ==========================================================================

// Limpa formatação de telefone para salvar somente números
function cleanPhone(phoneStr) {
    return phoneStr.replace(/\D/g, '');
}

// Formata número de telefone para visualização: (XX) XXXXX-XXXX
function formatPhone(phoneStr) {
    const numbers = cleanPhone(phoneStr);
    if (numbers.length === 11) {
        return `(${numbers.slice(0, 2)}) ${numbers.slice(2, 7)}-${numbers.slice(7)}`;
    } else if (numbers.length === 10) {
        return `(${numbers.slice(0, 2)}) ${numbers.slice(2, 6)}-${numbers.slice(6)}`;
    }
    return phoneStr;
}

// Aplica máscara de telefone em tempo de digitação no campo
function applyPhoneMask(inputElement) {
    inputElement.addEventListener('input', (e) => {
        let value = cleanPhone(e.target.value);
        if (value.length > 11) value = value.slice(0, 11);
        
        let formatted = '';
        if (value.length > 0) {
            formatted = '(' + value.slice(0, 2);
            if (value.length > 2) {
                formatted += ') ' + value.slice(2, 7);
                if (value.length > 7) {
                    formatted += '-' + value.slice(7, 11);
                }
            }
        }
        e.target.value = formatted;
    });
}

// Gera ID único
function generateUniqueId() {
    return 'user_' + Math.random().toString(36).substr(2, 9);
}

// Validação de senha: letras, números e símbolos especiais, min 6 caracteres
function validatePasswordStrength(password) {
    const hasLetters = /[a-zA-Z]/.test(password);
    const hasNumbers = /[0-9]/.test(password);
    const hasSpecial = /[^a-zA-Z0-9]/.test(password);
    return password.length >= 6 && hasLetters && hasNumbers && hasSpecial;
}

// Retorna data de hoje em formato legível YYYY-MM-DD
function getTodayDateString() {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

// Formata data do formato YYYY-MM-DD para DD/MM/YYYY
function formatDateDisplay(dateStr) {
    if (!dateStr) return '';
    const parts = dateStr.split('-');
    if (parts.length === 3) {
        return `${parts[2]}/${parts[1]}/${parts[0]}`;
    }
    return dateStr;
}

// Formata moeda (BRL)
function formatCurrency(value) {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
}

// Exibe mensagens toast/notificações flutuantes elegantes
function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast-message ${type}`;
    toast.textContent = message;
    
    // Estilo dinâmico rápido injetado
    toast.style.position = 'fixed';
    toast.style.bottom = '20px';
    toast.style.right = '20px';
    toast.style.padding = '14px 24px';
    toast.style.borderRadius = '8px';
    toast.style.color = '#fff';
    toast.style.fontFamily = 'var(--font-body)';
    toast.style.fontSize = '14px';
    toast.style.fontWeight = '600';
    toast.style.zIndex = '9999';
    toast.style.boxShadow = '0 10px 25px rgba(0,0,0,0.15)';
    toast.style.transition = 'all 0.3s ease';
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(20px)';
    
    if (type === 'success') toast.style.backgroundColor = 'var(--success)';
    else if (type === 'error') toast.style.backgroundColor = 'var(--danger)';
    else toast.style.backgroundColor = 'var(--text-primary)';
    
    document.body.appendChild(toast);
    
    // Anima a entrada
    setTimeout(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateY(0)';
    }, 50);
    
    // Remove depois de 3.5 segundos
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(20px)';
        setTimeout(() => toast.remove(), 300);
    }, 3500);
}

// ==========================================================================
// 3. ROTEAMENTO DE TELAS
// ==========================================================================

function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(screen => {
        screen.classList.add('hidden');
    });
    const target = document.getElementById(screenId);
    if (target) {
        target.classList.remove('hidden');
        window.scrollTo(0, 0);
    }
}

// ==========================================================================
// 4. FLUXO DE LOGIN E CADASTRO
// ==========================================================================

// Autenticar Usuário
document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const usernameInput = document.getElementById('login-username').value.trim().toLowerCase();
    const passwordInput = document.getElementById('login-password').value;

    let db;
    try { db = await getDB(); } catch { return; }
    appDB = db;
    const user = appDB.users.find(u => (u.username || '').toLowerCase() === usernameInput && u.password === passwordInput);

    if (user) {
        currentUser = user;
        sessionStorage.setItem('amies_session_user', JSON.stringify(user));

        document.getElementById('login-form').reset();

        if (!user.termsAccepted) {
            openTermsGate();
            return;
        }
        await enterApp(user);
    } else {
        showToast('Usuário ou senha inválidos!', 'error');
    }
});

async function enterApp(user) {
    showToast(`Bem-vinda, ${user.name}!`);
    if (user.role === 'master') {
        await renderAdminDashboard();
        showScreen('admin-screen');
    } else {
        await renderClientDashboard();
        showScreen('client-screen');
    }
}

// --- TERMOS DE USO (obrigatório no primeiro acesso) ---
function openTermsGate() {
    document.getElementById('terms-accept-checkbox').checked = false;
    document.getElementById('terms-accept-btn').setAttribute('disabled', 'true');
    openModal('terms-modal');
}
document.getElementById('terms-accept-checkbox').addEventListener('change', (e) => {
    document.getElementById('terms-accept-btn').disabled = !e.target.checked;
});
document.getElementById('terms-accept-btn').addEventListener('click', async () => {
    if (!currentUser) return;
    try {
        appDB = await getDB();
        const idx = appDB.users.findIndex(u => u.id === currentUser.id);
        if (idx === -1) return;
        appDB.users[idx].termsAccepted = true;
        await saveDB(appDB);
        currentUser = appDB.users[idx];
        sessionStorage.setItem('amies_session_user', JSON.stringify(currentUser));
        closeModal('terms-modal');
        await enterApp(currentUser);
    } catch (err) { showToast(err.message, 'error'); }
});

// Fluxo de Cadastro - Solicitar SMS
document.getElementById('signup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('signup-name').value.trim();
    const phone = document.getElementById('signup-phone').value;
    const username = document.getElementById('signup-username').value.trim().toLowerCase();
    const password = document.getElementById('signup-password').value;
    const confirmPassword = document.getElementById('signup-confirm-password').value;
    
    const phoneClean = cleanPhone(phone);
    
    if (phoneClean.length < 10) {
        showToast('Por favor, insira um número de celular válido.', 'error');
        return;
    }

    if (username.length < 3) {
        showToast('O nome de usuário deve ter pelo menos 3 caracteres.', 'error');
        return;
    }
    
    // Validações
    if (password !== confirmPassword) {
        showToast('As senhas digitadas não coincidem!', 'error');
        return;
    }
    
    if (!validatePasswordStrength(password)) {
        showToast('Sua senha deve conter pelo menos 6 caracteres, contendo letras, números e caracteres especiais.', 'error');
        return;
    }
    
    // Carrega banco de dados para verificar duplicados
    try { appDB = await getDB(); } catch { return; }
    const phoneExists = appDB.users.some(u => cleanPhone(u.phone) === phoneClean);
    if (phoneExists) {
        showToast('Este número de telefone já está cadastrado no sistema!', 'error');
        return;
    }
    const usernameExists = appDB.users.some(u => (u.username || '').toLowerCase() === username);
    if (usernameExists) {
        showToast('Este nome de usuário já está em uso. Escolha outro.', 'error');
        return;
    }
    
    // Armazena dados temporariamente para registrar somente após o SMS
    tempSignupData = {
        id: generateUniqueId(),
        name: name,
        phone: phoneClean,
        username: username,
        password: password,
        role: 'client',
        points: 0,
        cashback: 0.00,
        history: [],
        cashbackLedger: [],
        termsAccepted: false
    };
    
    // Gera código SMS simulado de 4 dígitos
    currentSmsCode = Math.floor(1000 + Math.random() * 9000).toString();
    
    // Prepara o Modal de SMS
    document.getElementById('sms-modal-phone').textContent = formatPhone(phoneClean);
    document.getElementById('sms-simulated-code').textContent = currentSmsCode;
    
    // Limpa campos anteriores de código no modal
    document.querySelectorAll('.sms-digit').forEach(input => input.value = '');
    
    // Abre modal de SMS
    openModal('sms-modal');
    // Foca no primeiro dígito
    document.querySelectorAll('.sms-digit')[0].focus();
});

// Comportamento dos Inputs do Código SMS (Pular foco automaticamente)
const smsDigits = document.querySelectorAll('.sms-digit');
smsDigits.forEach((digitInput, idx) => {
    digitInput.addEventListener('input', (e) => {
        // Aceita apenas números
        digitInput.value = digitInput.value.replace(/\D/g, '');
        if (digitInput.value && idx < smsDigits.length - 1) {
            smsDigits[idx + 1].focus();
        }
    });
    
    // Tratar Backspace para voltar o foco
    digitInput.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !digitInput.value && idx > 0) {
            smsDigits[idx - 1].focus();
        }
    });
});

// Cancelar verificação de SMS
document.getElementById('sms-btn-cancel').addEventListener('click', () => {
    closeModal('sms-modal');
    tempSignupData = null;
    currentSmsCode = '';
    showToast('Cadastro cancelado pelo usuário.', 'info');
});

// Confirmar verificação de SMS e efetuar Cadastro
document.getElementById('sms-btn-verify').addEventListener('click', async () => {
    let enteredCode = '';
    smsDigits.forEach(input => enteredCode += input.value);
    
    if (enteredCode.length < 4) {
        showToast('Por favor, insira o código de 4 dígitos enviado por SMS.', 'error');
        return;
    }
    
    if (enteredCode === currentSmsCode) {
        // Código correto, salva o novo cliente no banco
        try {
            appDB = await getDB();
            appDB.users.push(tempSignupData);
            await saveDB(appDB);
        } catch (err) { showToast(err.message, 'error'); return; }
        
        showToast('Cadastro realizado com sucesso! Faça seu login para acessar.');
        closeModal('sms-modal');
        
        // Limpa estado temporário
        tempSignupData = null;
        currentSmsCode = '';
        document.getElementById('signup-form').reset();
        
        // Vai para a tela de login
        showScreen('login-screen');
    } else {
        showToast('Código SMS inválido. Verifique e tente novamente.', 'error');
        // Limpa os campos para nova tentativa
        smsDigits.forEach(input => input.value = '');
        smsDigits[0].focus();
    }
});

// Navegação entre Telas de Login e Cadastro
document.getElementById('go-to-signup').addEventListener('click', (e) => {
    e.preventDefault();
    showScreen('signup-screen');
});

document.getElementById('go-to-login').addEventListener('click', (e) => {
    e.preventDefault();
    showScreen('login-screen');
});

// Logout
function logout() {
    currentUser = null;
    sessionStorage.removeItem('amies_session_user');
    showScreen('login-screen');
    showToast('Você saiu da sua conta.');
}
document.getElementById('client-logout').addEventListener('click', logout);
document.getElementById('admin-logout').addEventListener('click', logout);


// ==========================================================================
// 5. PAINEL DO CLIENTE (VISUALIZAÇÃO)
// ==========================================================================

async function renderClientDashboard() {
    if (!currentUser) return;
    
    // Atualiza cabeçalho
    document.getElementById('client-display-name').textContent = `Olá, ${currentUser.name}`;
    
    // Carrega dados atualizados do DB
    try { appDB = await getDB(); } catch { return; }
    const updatedClient = appDB.users.find(u => u.id === currentUser.id);
    if (!updatedClient) return;

    // Atualiza Cashback e Sessões Totais
    document.getElementById('client-cashback').textContent = formatCurrency(updatedClient.cashback);
    document.getElementById('client-total-sessions').textContent = updatedClient.history.length;
    document.getElementById('client-points-badge').textContent = `${updatedClient.points} / 10 Pontos`;
    
    // Renderiza círculos do Cartão Fidelidade
    const dotsContainer = document.getElementById('loyalty-dots-container');
    dotsContainer.innerHTML = '';
    
    const clientPoints = updatedClient.points || 0;
    
    for (let i = 1; i <= 10; i++) {
        const dot = document.createElement('div');
        dot.className = 'loyalty-dot';
        if (i <= clientPoints) {
            dot.classList.add('filled');
        } else {
            dot.textContent = i;
        }
        dotsContainer.appendChild(dot);
    }
    
    // Barra de Progresso
    const progressPercent = (clientPoints / 10) * 100;
    document.getElementById('loyalty-progress-bar').style.width = `${progressPercent}%`;
    
    const progressText = document.getElementById('loyalty-progress-text');
    const bonusBanner = document.getElementById('bonus-ready-banner');
    if (clientPoints >= 10) {
        progressText.innerHTML = '✨ <strong>Parabéns!</strong> Seu Cartão está completo. Resgate seu bônus no seu próximo procedimento!';
        bonusBanner.classList.remove('hidden');
    } else {
        progressText.textContent = `Faltam ${10 - clientPoints} ponto(s) para seu bônus!`;
        bonusBanner.classList.add('hidden');
    }
    
    // Extrato de Cashback (estilo extrato bancário)
    const ledgerTbody = document.getElementById('client-ledger-tbody');
    ledgerTbody.innerHTML = '';
    const ledger = updatedClient.cashbackLedger || [];
    if (ledger.length === 0) {
        ledgerTbody.innerHTML = `<tr><td colspan="4" class="empty-state">Nenhuma movimentação registrada ainda.</td></tr>`;
    } else {
        const sortedLedger = [...ledger].reverse();
        sortedLedger.forEach(entry => {
            const tr = document.createElement('tr');
            const isCredit = entry.type === 'credit';
            tr.innerHTML = `
                <td>${formatDateDisplay(entry.date)}</td>
                <td>${escapeHtml(entry.description)}</td>
                <td class="${isCredit ? 'ledger-credit' : 'ledger-debit'}">${isCredit ? '+' : '-'} ${formatCurrency(entry.amount)}</td>
                <td class="text-right ledger-balance">${formatCurrency(entry.balanceAfter)}</td>
            `;
            ledgerTbody.appendChild(tr);
        });
    }
    
    // Histórico de procedimentos
    const tbody = document.getElementById('client-history-tbody');
    tbody.innerHTML = '';
    
    if (updatedClient.history.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="empty-state">Nenhum procedimento registrado ainda.</td></tr>`;
    } else {
        // Ordena histórico do mais recente para o mais antigo
        const sortedHistory = [...updatedClient.history].reverse();
        sortedHistory.forEach(session => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${formatDateDisplay(session.date)}</td>
                <td><strong>${escapeHtml(session.procedure)}</strong></td>
                <td>${formatCurrency(session.value)}</td>
                <td><span style="color:var(--success); font-weight:600;">+ ${formatCurrency(session.cashback)}</span></td>
                <td><span class="badge" style="background-color: var(--accent-light); color: var(--text-primary); font-size:11px;">${escapeHtml(session.textPoints) || '-'}</span></td>
            `;
            tbody.appendChild(tr);
        });
    }
}


// ==========================================================================
// 6. PAINEL ADMINISTRATIVO (MESTRE) - EDICÃO E LANÇAMENTO
// ==========================================================================

async function renderAdminDashboard() {
    try { appDB = await getDB(); } catch { return; }
    
    // Filtrar apenas clientes (excluir o mestre)
    const clientsOnly = appDB.users.filter(u => u.role === 'client');
    
    // Calcular estatísticas da Dashboard Admin
    document.getElementById('admin-stat-clients').textContent = clientsOnly.length;
    
    const totalPoints = clientsOnly.reduce((acc, curr) => acc + (curr.points || 0), 0);
    document.getElementById('admin-stat-points').textContent = totalPoints;
    
    const totalCashback = clientsOnly.reduce((acc, curr) => acc + (curr.cashback || 0), 0);
    document.getElementById('admin-stat-cashback').textContent = formatCurrency(totalCashback);
    
    // Filtro de Busca
    const searchQuery = cleanPhone(document.getElementById('admin-search-client').value.toLowerCase());
    const searchRaw = document.getElementById('admin-search-client').value.toLowerCase().trim();
    
    // Renderiza a lista na tabela
    const tbody = document.getElementById('admin-clients-tbody');
    tbody.innerHTML = '';
    
    const filteredClients = clientsOnly.filter(c => {
        const nameMatches = c.name.toLowerCase().includes(searchRaw);
        const phoneMatches = cleanPhone(c.phone).includes(searchQuery);
        return nameMatches || phoneMatches;
    });
    
    if (filteredClients.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="empty-state">Nenhum cliente correspondente encontrado.</td></tr>`;
    } else {
        filteredClients.forEach(client => {
            const tr = document.createElement('tr');
            
            const pointsDisplay = client.points >= 10 
                ? `<span class="badge" style="background-color: var(--success); color:#fff;">Completo (${client.points}/10)</span>`
                : `<span class="badge" style="background-color: var(--accent-light); color: var(--text-primary);">${client.points}/10</span>`;

            tr.innerHTML = `
                <td><strong>${escapeHtml(client.name)}</strong></td>
                <td>${formatPhone(client.phone)}</td>
                <td>${escapeHtml(client.username) || '-'}</td>
                <td>${pointsDisplay}</td>
                <td><strong style="color:var(--text-primary);">${formatCurrency(client.cashback)}</strong></td>
                <td class="text-right">
                    <div class="action-buttons-group">
                        <button class="btn-icon btn-launch" data-id="${client.id}" title="Lançar Sessão/Cashback">✨</button>
                        <button class="btn-icon btn-withdraw" data-id="${client.id}" title="Resgatar Cashback">🏦</button>
                        <button class="btn-icon btn-edit" data-id="${client.id}" title="Editar Dados">✏️</button>
                        <button class="btn-icon delete btn-delete" data-id="${client.id}" title="Excluir Cliente">🗑️</button>
                    </div>
                </td>
            `;
            tbody.appendChild(tr);
        });
        
        // Vincula eventos nos botões recém-criados
        attachAdminTableEvents();
    }
}

// Listener para a barra de busca do administrador
document.getElementById('admin-search-client').addEventListener('input', () => { renderAdminDashboard(); });

// Vincula eventos para os botões de ação da tabela do Administrador
function attachAdminTableEvents() {
    // 1. Botão de Lançar Procedimento
    document.querySelectorAll('.btn-launch').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const clientId = e.currentTarget.getAttribute('data-id');
            await openLaunchModal(clientId);
        });
    });
    
    // 2. Botão de Resgatar Cashback (lança retirada no extrato)
    document.querySelectorAll('.btn-withdraw').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const clientId = e.currentTarget.getAttribute('data-id');
            await openWithdrawModal(clientId);
        });
    });

    // 3. Botão de Editar Dados do Cliente
    document.querySelectorAll('.btn-edit').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const clientId = e.currentTarget.getAttribute('data-id');
            await openEditModal(clientId);
        });
    });
    
    // 4. Botão de Excluir Cliente
    document.querySelectorAll('.btn-delete').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const clientId = e.currentTarget.getAttribute('data-id');
            await deleteClient(clientId);
        });
    });
}

// Excluir cliente permanentemente (Apenas Mestre)
async function deleteClient(clientId) {
    try { appDB = await getDB(); } catch { return; }
    const client = appDB.users.find(u => u.id === clientId);
    if (!client) return;
    
    const confirmDelete = confirm(`Deseja realmente EXCLUIR o cadastro da cliente "${client.name}"?\nEsta ação apagará todo o histórico de pontos e cashback permanentemente.`);
    
    if (confirmDelete) {
        appDB.users = appDB.users.filter(u => u.id !== clientId);
        try { await saveDB(appDB); } catch (err) { showToast(err.message, 'error'); return; }
        showToast(`Cliente ${client.name} excluída com sucesso!`, 'success');
        await renderAdminDashboard();
    }
}

// ==========================================================================
// 7. GERENCIAMENTO DE MODAIS DO ADMINISTRADOR
// ==========================================================================

// Helpers gerais para abrir/fechar modais
function openModal(modalId) {
    document.getElementById(modalId).classList.remove('hidden');
}

function closeModal(modalId) {
    document.getElementById(modalId).classList.add('hidden');
}

// Fechamento automático de qualquer modal ao clicar em fechar ou no background
document.querySelectorAll('.modal-close-x, .modal-close-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        const overlay = e.target.closest('.modal-overlay');
        if (overlay) {
            overlay.classList.add('hidden');
        }
    });
});

// Fechar modal ao clicar fora da área do card
document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            overlay.classList.add('hidden');
        }
    });
});

// --- MODAL NOVO CLIENTE (MANUAL PELO ADMIN) ---
document.getElementById('btn-add-client').addEventListener('click', () => {
    document.getElementById('add-client-form').reset();
    openModal('add-client-modal');
});

document.getElementById('add-client-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('new-client-name').value.trim();
    const phone = document.getElementById('new-client-phone').value;
    const username = document.getElementById('new-client-username').value.trim().toLowerCase();
    const password = document.getElementById('new-client-password').value;
    
    const phoneClean = cleanPhone(phone);
    
    if (phoneClean.length < 10) {
        showToast('Telefone inválido!', 'error');
        return;
    }

    if (username.length < 3) {
        showToast('O nome de usuário deve ter pelo menos 3 caracteres.', 'error');
        return;
    }
    
    try { appDB = await getDB(); } catch { return; }
    const phoneExists = appDB.users.some(u => cleanPhone(u.phone) === phoneClean);
    if (phoneExists) {
        showToast('Telefone já cadastrado!', 'error');
        return;
    }
    const usernameExists = appDB.users.some(u => (u.username || '').toLowerCase() === username);
    if (usernameExists) {
        showToast('Este nome de usuário já está em uso!', 'error');
        return;
    }
    
    const newClient = {
        id: generateUniqueId(),
        name: name,
        phone: phoneClean,
        username: username,
        password: password,
        role: 'client',
        points: 0,
        cashback: 0.00,
        history: [],
        cashbackLedger: [],
        termsAccepted: false
    };
    
    appDB.users.push(newClient);
    try { await saveDB(appDB); } catch (err) { showToast(err.message, 'error'); return; }
    
    showToast(`Cliente ${name} cadastrada com sucesso!`);
    closeModal('add-client-modal');
    await renderAdminDashboard();
});


// --- MODAL EDITAR CLIENTE ---
async function openEditModal(clientId) {
    try { appDB = await getDB(); } catch { return; }
    const client = appDB.users.find(u => u.id === clientId);
    if (!client) return;
    
    document.getElementById('edit-client-id').value = client.id;
    document.getElementById('edit-name').value = client.name;
    document.getElementById('edit-phone').value = formatPhone(client.phone);
    document.getElementById('edit-username').value = client.username || '';
    document.getElementById('edit-new-password').value = '';
    document.getElementById('edit-points').value = client.points || 0;
    document.getElementById('edit-cashback').value = client.cashback.toFixed(2);
    
    openModal('edit-modal');
}

document.getElementById('edit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const clientId = document.getElementById('edit-client-id').value;
    const name = document.getElementById('edit-name').value.trim();
    const phone = cleanPhone(document.getElementById('edit-phone').value);
    const username = document.getElementById('edit-username').value.trim().toLowerCase();
    const newPassword = document.getElementById('edit-new-password').value;
    const points = parseInt(document.getElementById('edit-points').value, 10);
    const cashback = parseFloat(document.getElementById('edit-cashback').value);
    
    if (points < 0 || points > 10) {
        showToast('Os pontos do cartão fidelidade devem estar entre 0 e 10.', 'error');
        return;
    }

    if (username.length < 3) {
        showToast('O nome de usuário deve ter pelo menos 3 caracteres.', 'error');
        return;
    }

    try { appDB = await getDB(); } catch { return; }
    
    // Validação de telefone duplicado em outros usuários
    const phoneExists = appDB.users.some(u => u.id !== clientId && cleanPhone(u.phone) === phone);
    if (phoneExists) {
        showToast('Este telefone já está cadastrado em outro usuário!', 'error');
        return;
    }

    // Validação de usuário duplicado em outros usuários (incluindo o admin)
    const usernameExists = appDB.users.some(u => u.id !== clientId && (u.username || '').toLowerCase() === username);
    if (usernameExists) {
        showToast('Este nome de usuário já está em uso por outra pessoa!', 'error');
        return;
    }

    const clientIdx = appDB.users.findIndex(u => u.id === clientId);
    if (clientIdx !== -1) {
        appDB.users[clientIdx].name = name;
        appDB.users[clientIdx].phone = phone;
        appDB.users[clientIdx].username = username;
        if (newPassword.trim()) {
            appDB.users[clientIdx].password = newPassword.trim();
        }
        appDB.users[clientIdx].points = points;
        appDB.users[clientIdx].cashback = cashback;
        
        try { await saveDB(appDB); } catch (err) { showToast(err.message, 'error'); return; }
        showToast('Cadastro de cliente atualizado!');
        closeModal('edit-modal');
        await renderAdminDashboard();
    }
});


// --- MODAL LANÇAR PROCEDIMENTO ---

// Mostrar ou ocultar campo de outro procedimento baseado no select
document.getElementById('launch-procedure').addEventListener('change', (e) => {
    const customGroup = document.getElementById('custom-procedure-group');
    if (e.target.value === 'Outro Procedimento') {
        customGroup.classList.remove('hidden');
        document.getElementById('launch-custom-procedure').setAttribute('required', 'true');
    } else {
        customGroup.classList.add('hidden');
        document.getElementById('launch-custom-procedure').removeAttribute('required');
    }
});

// Mostrar ou ocultar campo de porcentagem de cashback personalizada
function updateCustomCashbackField() {
    const isCustom = document.getElementById('cashback-ratio-custom').checked;
    const group = document.getElementById('custom-cashback-group');
    const input = document.getElementById('launch-custom-cashback');
    if (isCustom) {
        group.classList.remove('hidden');
        input.setAttribute('required', 'true');
        input.focus();
    } else {
        group.classList.add('hidden');
        input.removeAttribute('required');
        input.value = '';
    }
}
document.querySelectorAll('input[name="cashback-ratio"]').forEach(radio => {
    radio.addEventListener('change', updateCustomCashbackField);
});

// Botões de valor rápido: preenche o campo de valor com um clique
document.querySelectorAll('.quick-value-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        document.querySelectorAll('.quick-value-btn').forEach(b => b.classList.remove('active'));
        const valueInput = document.getElementById('launch-value');
        if (btn.id === 'btn-other-value') {
            btn.classList.add('active');
            valueInput.value = '';
            valueInput.focus();
        } else {
            btn.classList.add('active');
            valueInput.value = btn.getAttribute('data-value');
        }
    });
});

async function openLaunchModal(clientId) {
    try { appDB = await getDB(); } catch { return; }
    const client = appDB.users.find(u => u.id === clientId);
    if (!client) return;
    
    document.getElementById('launch-form').reset();
    document.getElementById('custom-procedure-group').classList.add('hidden');
    document.getElementById('launch-custom-procedure').removeAttribute('required');
    document.querySelectorAll('.quick-value-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('custom-cashback-group').classList.add('hidden');
    document.getElementById('launch-custom-cashback').removeAttribute('required');
    
    document.getElementById('launch-client-id').value = client.id;
    document.getElementById('launch-client-name').textContent = client.name;
    
    // Verifica se pode resgatar bônus (tem 10 pontos)
    const redeemContainer = document.getElementById('launch-redeem-container');
    const points = client.points || 0;
    
    if (points >= 10) {
        redeemContainer.classList.remove('hidden');
    } else {
        redeemContainer.classList.add('hidden');
    }
    
    openModal('launch-modal');
}

// Salvar Lançamento do Procedimento
document.getElementById('launch-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const clientId = document.getElementById('launch-client-id').value;
    const procedureSelect = document.getElementById('launch-procedure').value;
    const customProcedure = document.getElementById('launch-custom-procedure').value.trim();
    const value = parseFloat(document.getElementById('launch-value').value);
    const addPointChecked = document.getElementById('launch-add-point').checked;
    const redeemChecked = document.getElementById('launch-redeem-bonus').checked;
    
    // Pega a taxa de cashback selecionada dos radio buttons
    const ratioInput = document.querySelector('input[name="cashback-ratio"]:checked');
    let cashbackRatio;
    if (ratioInput.value === 'custom') {
        // Porcentagem digitada manualmente (aceita decimais, ex: 4.5)
        cashbackRatio = parseFloat(document.getElementById('launch-custom-cashback').value);
        if (isNaN(cashbackRatio) || cashbackRatio < 0 || cashbackRatio > 100) {
            showToast('Informe uma porcentagem de cashback válida (entre 0 e 100).', 'error');
            return;
        }
    } else {
        cashbackRatio = parseFloat(ratioInput.value); // 0, 3, 5, 7 ou 10
    }
    
    const procedureName = procedureSelect === 'Outro Procedimento' ? customProcedure : procedureSelect;
    
    try { appDB = await getDB(); } catch { return; }
    const clientIdx = appDB.users.findIndex(u => u.id === clientId);
    if (clientIdx === -1) return;
    
    const client = appDB.users[clientIdx];
    
    // Processamento da Pontuação e Bônus
    let currentPoints = client.points || 0;
    let pointsAdded = 0;
    let textPoints = '';
    
    if (redeemChecked) {
        // Resgata o prêmio (Zera os 10 pontos)
        currentPoints -= 10;
        if (currentPoints < 0) currentPoints = 0;
        textPoints = '🎁 Resgate Bônus';
    }
    
    if (addPointChecked) {
        currentPoints += 1;
        // Não deixa passar de 10 se não for zerado
        if (currentPoints > 10) currentPoints = 10;
        pointsAdded = 1;
        if (!textPoints) textPoints = '+1 Ponto';
    }
    
    // Cálculo do Cashback ganho
    const cashbackEarned = value * (cashbackRatio / 100);
    const newCashbackBalance = (client.cashback || 0) + cashbackEarned;
    
    // Monta o objeto de histórico do procedimento
    const newSession = {
        date: getTodayDateString(),
        procedure: procedureName,
        value: value,
        cashback: cashbackEarned,
        pointsAdded: pointsAdded,
        textPoints: textPoints || 'Sem Ponto'
    };
    
    // Atualiza cliente no banco
    client.points = currentPoints;
    client.cashback = newCashbackBalance;
    if (!client.history) client.history = [];
    client.history.push(newSession);
    
    // Registra a entrada de crédito no extrato de cashback
    if (!client.cashbackLedger) client.cashbackLedger = [];
    if (cashbackEarned > 0) {
        client.cashbackLedger.push({
            date: getTodayDateString(),
            type: 'credit',
            amount: cashbackEarned,
            description: `Cashback - ${procedureName}`,
            balanceAfter: newCashbackBalance
        });
    }
    
    try { await saveDB(appDB); } catch (err) { showToast(err.message, 'error'); return; }
    showToast(`Procedimento lançado para ${client.name}! Cashback de ${formatCurrency(cashbackEarned)} adicionado.`);
    closeModal('launch-modal');
    await renderAdminDashboard();
});


// ==========================================================================
// 7b. MODAL RESGATAR CASHBACK (Retirada - alimenta o extrato do cliente)
// ==========================================================================

async function openWithdrawModal(clientId) {
    try { appDB = await getDB(); } catch { return; }
    const client = appDB.users.find(u => u.id === clientId);
    if (!client) return;

    document.getElementById('withdraw-form').reset();
    document.getElementById('withdraw-client-id').value = client.id;
    document.getElementById('withdraw-client-name').textContent = client.name;
    document.getElementById('withdraw-available-balance').textContent = formatCurrency(client.cashback || 0);

    openModal('withdraw-modal');
}

document.getElementById('withdraw-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const clientId = document.getElementById('withdraw-client-id').value;
    const amount = parseFloat(document.getElementById('withdraw-value').value);
    const note = document.getElementById('withdraw-note').value.trim();

    try { appDB = await getDB(); } catch { return; }
    const clientIdx = appDB.users.findIndex(u => u.id === clientId);
    if (clientIdx === -1) return;

    const client = appDB.users[clientIdx];
    const currentBalance = client.cashback || 0;

    if (amount <= 0) {
        showToast('Informe um valor válido para retirada.', 'error');
        return;
    }

    if (amount > currentBalance) {
        showToast('O valor da retirada não pode ser maior que o saldo disponível!', 'error');
        return;
    }

    const newBalance = currentBalance - amount;
    client.cashback = newBalance;

    if (!client.cashbackLedger) client.cashbackLedger = [];
    client.cashbackLedger.push({
        date: getTodayDateString(),
        type: 'debit',
        amount: amount,
        description: note || 'Resgate na recepção',
        balanceAfter: newBalance
    });

    try { await saveDB(appDB); } catch (err) { showToast(err.message, 'error'); return; }
    showToast(`Retirada de ${formatCurrency(amount)} registrada para ${client.name}.`);
    closeModal('withdraw-modal');
    await renderAdminDashboard();
});


// ==========================================================================
// 7c. MODAL MINHA CONTA (Admin troca o próprio usuário/senha)
// ==========================================================================

document.getElementById('btn-admin-account').addEventListener('click', async () => {
    if (!currentUser) return;
    try { appDB = await getDB(); } catch { return; }
    const adminUser = appDB.users.find(u => u.id === currentUser.id);
    if (!adminUser) return;

    document.getElementById('admin-account-form').reset();
    document.getElementById('admin-account-username').value = adminUser.username || '';

    openModal('admin-account-modal');
});

document.getElementById('admin-account-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const newUsername = document.getElementById('admin-account-username').value.trim().toLowerCase();
    const newPassword = document.getElementById('admin-account-password').value;
    const confirmPassword = document.getElementById('admin-account-confirm-password').value;

    if (newUsername.length < 3) {
        showToast('O nome de usuário deve ter pelo menos 3 caracteres.', 'error');
        return;
    }

    if (newPassword && newPassword !== confirmPassword) {
        showToast('As senhas digitadas não coincidem!', 'error');
        return;
    }

    try { appDB = await getDB(); } catch { return; }
    const usernameExists = appDB.users.some(u => u.id !== currentUser.id && (u.username || '').toLowerCase() === newUsername);
    if (usernameExists) {
        showToast('Este nome de usuário já está em uso!', 'error');
        return;
    }

    const adminIdx = appDB.users.findIndex(u => u.id === currentUser.id);
    if (adminIdx === -1) return;

    appDB.users[adminIdx].username = newUsername;
    if (newPassword.trim()) {
        appDB.users[adminIdx].password = newPassword.trim();
    }

    try { await saveDB(appDB); } catch (err) { showToast(err.message, 'error'); return; }
    currentUser = appDB.users[adminIdx];
    sessionStorage.setItem('amies_session_user', JSON.stringify(currentUser));

    showToast('Suas credenciais foram atualizadas com sucesso!');
    closeModal('admin-account-modal');
});


// ==========================================================================
// 8. CONFIGURAÇÕES GERAIS E ATIVAÇÕES NA INICIALIZAÇÃO
// ==========================================================================

// Aplica máscaras nos campos de telefone
applyPhoneMask(document.getElementById('signup-phone'));
applyPhoneMask(document.getElementById('edit-phone'));
applyPhoneMask(document.getElementById('new-client-phone'));

// Sugere automaticamente um nome de usuário a partir do nome digitado (se o campo ainda estiver vazio)
document.getElementById('signup-name').addEventListener('blur', () => {
    const usernameField = document.getElementById('signup-username');
    if (!usernameField.value.trim()) {
        usernameField.value = generateUsernameSlug(document.getElementById('signup-name').value);
    }
});
document.getElementById('new-client-name').addEventListener('blur', () => {
    const usernameField = document.getElementById('new-client-username');
    if (!usernameField.value.trim()) {
        usernameField.value = generateUsernameSlug(document.getElementById('new-client-name').value);
    }
});

// Verifica se já existe um usuário logado na sessão ao carregar a página
document.addEventListener('DOMContentLoaded', async () => {
    if (currentUser) {
        try {
            appDB = await getDB();
            const freshUser = appDB.users.find(u => u.id === currentUser.id);
            if (!freshUser) { // conta pode ter sido excluída nesse meio tempo
                currentUser = null;
                sessionStorage.removeItem('amies_session_user');
                showScreen('login-screen');
                return;
            }
            currentUser = freshUser;
            sessionStorage.setItem('amies_session_user', JSON.stringify(currentUser));

            if (!currentUser.termsAccepted) {
                showScreen('login-screen');
                openTermsGate();
                return;
            }
            if (currentUser.role === 'master') {
                await renderAdminDashboard();
                showScreen('admin-screen');
            } else {
                await renderClientDashboard();
                showScreen('client-screen');
            }
        } catch {
            showScreen('login-screen');
        }
    } else {
        showScreen('login-screen');
    }
});
