// ===== Gasto na Foto =====
// A IA vem de graça pelo Puter.js — não precisa de chave!

// Cada categoria tem seu emoji
const EMOJIS = { Mercado: "🛒", Transporte: "🚗", Comida: "🍔", Saúde: "💊", Lazer: "🎉", Casa: "🏠", Outros: "💸" };

// Onde os gastos ficam guardados no navegador (agora sobrevivem ao recarregar!)
const CHAVE_STORAGE = "gastoNaFoto.gastos";

// Formata dinheiro do jeito brasileiro: 1234.5 vira "R$ 1.234,50"
const moeda = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

// Elementos da página que usamos o tempo todo
const inputFoto = document.getElementById("foto");
const areaFoto = document.querySelector(".area-foto");

let gastos = carregarGastos();   // começa com o que já estava salvo
let processando = false;         // evita mandar duas fotos ao mesmo tempo
let ultimoAdicionado = null;     // pra animar só o cartão que acabou de chegar
let totalMostrado = 0;           // valor atual na tela (usado na animação)
let animacaoTotal = null;
let statusTimer = null;
let toastTimer = null;

// ===== Guardar e carregar do navegador =====

function carregarGastos() {
  try {
    const salvo = localStorage.getItem(CHAVE_STORAGE);
    const lista = salvo ? JSON.parse(salvo) : [];
    if (!Array.isArray(lista)) return [];
    // garante que cada gasto tem id e total numérico, mesmo vindo de versões antigas
    return lista.map(gasto => ({ ...gasto, id: gasto.id || gerarId(), total: paraNumero(gasto.total) }));
  } catch (erro) {
    return [];
  }
}

function salvarGastos() {
  try {
    localStorage.setItem(CHAVE_STORAGE, JSON.stringify(gastos));
  } catch (erro) {
    // O navegador limita o espaço. Se encheu, salvamos sem as fotos (o resto é o que importa).
    try {
      const semFotos = gastos.map(({ foto, ...resto }) => resto);
      localStorage.setItem(CHAVE_STORAGE, JSON.stringify(semFotos));
    } catch (erroDeNovo) {
      console.error("Não deu pra salvar os gastos:", erroDeNovo);
    }
  }
}

// ===== Lendo as fotos =====

async function lerArquivos(arquivos) {
  const imagens = [...arquivos].filter(arquivo => arquivo && arquivo.type.startsWith("image/"));
  if (imagens.length === 0) return;

  if (processando) {
    mostrarStatus("Calma! Ainda estou lendo o comprovante anterior 😅", "erro");
    return;
  }

  processando = true;
  areaFoto.classList.add("ocupada");

  let lidos = 0;
  let ultimoErro = null;

  for (let i = 0; i < imagens.length; i++) {
    const posicao = imagens.length > 1 ? ` ${i + 1} de ${imagens.length}` : "";
    mostrarStatus(`Lendo comprovante${posicao}…`, "carregando");

    try {
      const original = await arquivoParaDataURL(imagens[i]);
      const fotoParaIA = await redimensionar(original, 1600, 0.9); // menor = mais rápido pra IA
      const miniatura = await redimensionar(original, 480, 0.7);   // versão pequena pra guardar

      const gasto = await analisarComIA(fotoParaIA);
      gasto.id = gerarId();
      gasto.data = Date.now();
      gasto.foto = miniatura;

      gastos.unshift(gasto); // o mais novo aparece primeiro
      ultimoAdicionado = gasto.id;
      salvarGastos();
      mostrarGastos();
      lidos++;
    } catch (erro) {
      console.error("Falha ao ler comprovante:", erro);
      ultimoErro = erro;
    }
  }

  processando = false;
  areaFoto.classList.remove("ocupada");

  const falhas = imagens.length - lidos;
  if (falhas === 0) {
    mostrarStatus(lidos === 1 ? "✅ Comprovante anotado!" : `✅ ${lidos} comprovantes anotados!`, "ok");
  } else if (lidos > 0) {
    mostrarStatus(`⚠️ Anotei ${lidos} de ${imagens.length}. ${mensagemDoErro(ultimoErro)}`, "erro");
  } else {
    mostrarStatus(`😕 ${mensagemDoErro(ultimoErro)}`, "erro");
  }
}

function mensagemDoErro(erro) {
  if (erro && erro.naoEComprovante) return "Essa foto não parece um comprovante 🤔";
  if (erro && erro.message === "tempo esgotado") return "A IA demorou demais pra responder. Tenta de novo?";
  return "Não consegui ler esse comprovante. Tenta uma foto mais nítida, com boa luz.";
}

// Transforma o arquivo escolhido em texto (dataURL) que dá pra mostrar e enviar
function arquivoParaDataURL(arquivo) {
  return new Promise((resolver, rejeitar) => {
    const leitor = new FileReader();
    leitor.onload = () => resolver(leitor.result);
    leitor.onerror = () => rejeitar(new Error("não consegui abrir o arquivo"));
    leitor.readAsDataURL(arquivo);
  });
}

// Diminui a foto (se precisar) e comprime em JPEG
function redimensionar(dataURL, ladoMaximo, qualidade) {
  return new Promise((resolver, rejeitar) => {
    const imagem = new Image();
    imagem.onload = function () {
      const escala = Math.min(1, ladoMaximo / Math.max(imagem.width, imagem.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(imagem.width * escala);
      canvas.height = Math.round(imagem.height * escala);
      canvas.getContext("2d").drawImage(imagem, 0, 0, canvas.width, canvas.height);
      resolver(canvas.toDataURL("image/jpeg", qualidade));
    };
    imagem.onerror = () => rejeitar(new Error("arquivo de imagem inválido"));
    imagem.src = dataURL;
  });
}

// ===== A IA olha o comprovante =====

async function analisarComIA(foto) {
  const pedido =
    'Olhe a foto deste comprovante. Liste CADA item comprado separadamente com seu valor, e o total pago. ' +
    'Responda APENAS um JSON, sem nada fora dele: ' +
    '{"estabelecimento":"","categoria":"","itens":[{"nome":"","valor":0}],"total":0}. ' +
    'Valores só com o número, usando ponto como separador decimal. ' +
    'A categoria tem que ser uma destas: Mercado, Transporte, Comida, Saúde, Lazer, Casa, Outros. ' +
    'Se a foto NÃO for um comprovante, nota ou recibo, responda apenas: {"erro":"nao_e_comprovante"}.';

  // Se a IA travar, desistimos depois de 90 segundos
  const resposta = await Promise.race([
    puter.ai.chat(pedido, foto),
    new Promise((_, rejeitar) => setTimeout(() => rejeitar(new Error("tempo esgotado")), 90000)),
  ]);

  const texto = extrairTexto(resposta);
  // A IA às vezes escreve texto em volta do JSON. Pegamos só o miolo entre { e }.
  const inicio = texto.indexOf("{");
  const fim = texto.lastIndexOf("}");
  if (inicio === -1 || fim === -1) throw new Error("a IA não devolveu JSON: " + texto);

  const bruto = JSON.parse(texto.slice(inicio, fim + 1));

  if (bruto.erro) {
    const erro = new Error("não é comprovante");
    erro.naoEComprovante = true;
    throw erro;
  }

  return arrumarGasto(bruto);
}

// A resposta da IA pode vir em formatos diferentes — aqui pegamos só o texto
function extrairTexto(resposta) {
  if (!resposta) return "";
  if (typeof resposta === "string") return resposta;
  const conteudo = (resposta.message && resposta.message.content) ?? resposta.text ?? "";
  if (Array.isArray(conteudo)) return conteudo.map(parte => parte.text || "").join(" ");
  return String(conteudo);
}

// Confere e arruma o que a IA mandou (nunca confie cegamente 😉)
function arrumarGasto(bruto) {
  const itens = (Array.isArray(bruto.itens) ? bruto.itens : [])
    .map(item => ({ nome: String(item?.nome ?? "").trim() || "Item", valor: paraNumero(item?.valor) }))
    .filter(item => item.valor >= 0);

  let total = paraNumero(bruto.total);
  if (!total) total = itens.reduce((soma, item) => soma + item.valor, 0); // sem total? soma os itens
  if (!total) throw new Error("comprovante sem valor");

  return {
    estabelecimento: String(bruto.estabelecimento ?? "").trim() || "Estabelecimento",
    categoria: EMOJIS[bruto.categoria] ? bruto.categoria : "Outros",
    itens: itens,
    total: total,
  };
}

// Aceita número ou texto: 12.34, "12,34", "R$ 1.234,56"...
function paraNumero(valor) {
  if (typeof valor === "number" && isFinite(valor)) return Math.abs(valor);
  if (typeof valor !== "string") return 0;
  let texto = valor.replace(/[^\d.,-]/g, "");
  if (texto.includes(",")) texto = texto.replace(/\./g, "").replace(",", "."); // jeito brasileiro
  const numero = parseFloat(texto);
  return isFinite(numero) ? Math.abs(numero) : 0;
}

// ===== Desenhando na tela =====

function mostrarGastos() {
  const lista = document.getElementById("lista");
  lista.innerHTML = "";

  if (gastos.length === 0) {
    lista.innerHTML = '<p class="vazio">Nenhum comprovante ainda. Fotografe o primeiro! 👆</p>';
  }

  let geral = 0;
  for (const gasto of gastos) {
    geral += gasto.total;
    lista.appendChild(montarCartao(gasto));
  }
  ultimoAdicionado = null; // a animação de "novo" só vale uma vez

  animarTotal(geral);
  document.getElementById("quantos").innerText = gastos.length;
  document.getElementById("limpar").hidden = gastos.length === 0;
}

function montarCartao(gasto) {
  const emoji = EMOJIS[gasto.categoria] || "💸";
  const cartao = document.createElement("div");
  cartao.className = "comprovante" + (gasto.id === ultimoAdicionado ? " novo" : "");

  const linhasItens = (gasto.itens || [])
    .map(item => `<li><span>${escapar(item.nome)}</span><span>${moeda.format(item.valor)}</span></li>`)
    .join("");

  cartao.innerHTML = `
    <div class="cabecalho">
      <span class="emoji${gasto.foto ? " tem-foto" : ""}" ${gasto.foto ? 'title="Ver a foto do comprovante" role="button" tabindex="0"' : ""}>${emoji}</span>
      <div class="quem">
        <strong>${escapar(gasto.estabelecimento)}</strong>
        <span class="data">${formatarData(gasto.data)}</span>
      </div>
      <small>${escapar(gasto.categoria)}</small>
      <button class="apagar" title="Apagar este comprovante" aria-label="Apagar comprovante">✕</button>
    </div>
    ${linhasItens ? `<ul class="itens">${linhasItens}</ul>` : ""}
    <div class="total-nota"><span>Total da nota</span><strong>${moeda.format(gasto.total)}</strong></div>`;

  cartao.querySelector(".apagar").addEventListener("click", () => apagarGasto(gasto.id));

  if (gasto.foto) {
    const emojiElemento = cartao.querySelector(".emoji");
    emojiElemento.addEventListener("click", () => abrirFoto(gasto.foto));
    emojiElemento.addEventListener("keydown", evento => {
      if (evento.key === "Enter" || evento.key === " ") {
        evento.preventDefault();
        abrirFoto(gasto.foto);
      }
    });
  }

  return cartao;
}

// Troca <, > etc. por versões inofensivas — a IA pode devolver qualquer coisa!
function escapar(texto) {
  const div = document.createElement("div");
  div.innerText = String(texto ?? "");
  return div.innerHTML;
}

// "hoje às 14:32", "ontem às 09:10" ou "05/08 às 18:00"
function formatarData(timestamp) {
  if (!timestamp) return "";
  const data = new Date(timestamp);
  const hoje = new Date();
  const ontem = new Date();
  ontem.setDate(hoje.getDate() - 1);
  const hora = data.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  if (data.toDateString() === hoje.toDateString()) return "hoje às " + hora;
  if (data.toDateString() === ontem.toDateString()) return "ontem às " + hora;
  return data.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) + " às " + hora;
}

// O número do total "corre" até o valor novo, tipo painel de banco
function animarTotal(novoTotal) {
  cancelAnimationFrame(animacaoTotal);
  const elemento = document.getElementById("total");
  const inicio = totalMostrado;
  const duracao = 500;
  const comeco = performance.now();

  function passo(agora) {
    const progresso = Math.min((agora - comeco) / duracao, 1);
    const suave = 1 - Math.pow(1 - progresso, 3); // desacelera no final
    totalMostrado = inicio + (novoTotal - inicio) * suave;
    elemento.innerText = moeda.format(totalMostrado);
    if (progresso < 1) animacaoTotal = requestAnimationFrame(passo);
  }

  animacaoTotal = requestAnimationFrame(passo);
}

// Mostra a foto do comprovante em tela cheia (clique ou Esc pra fechar)
function abrirFoto(src) {
  const visor = document.createElement("div");
  visor.className = "visor";
  const imagem = document.createElement("img");
  imagem.src = src;
  imagem.alt = "Foto do comprovante";
  visor.appendChild(imagem);

  function fechar() {
    visor.remove();
    document.removeEventListener("keydown", aoTeclar);
  }
  function aoTeclar(evento) {
    if (evento.key === "Escape") fechar();
  }

  visor.addEventListener("click", fechar);
  document.addEventListener("keydown", aoTeclar);
  document.body.appendChild(visor);
}

// ===== Apagando =====

function apagarGasto(id) {
  const posicao = gastos.findIndex(gasto => gasto.id === id);
  if (posicao === -1) return;

  const apagado = gastos[posicao];
  gastos.splice(posicao, 1);
  salvarGastos();
  mostrarGastos();

  // dá 6 segundos pra se arrepender 😉
  mostrarToast("Comprovante apagado.", "Desfazer", () => {
    gastos.splice(Math.min(posicao, gastos.length), 0, apagado);
    salvarGastos();
    mostrarGastos();
  });
}

// ===== Avisos na tela =====

function mostrarStatus(mensagem, tipo) {
  clearTimeout(statusTimer);
  const status = document.getElementById("status");
  status.classList.toggle("erro", tipo === "erro");
  status.innerHTML = "";
  if (tipo === "carregando") {
    const spinner = document.createElement("span");
    spinner.className = "girando";
    status.appendChild(spinner);
  }
  status.append(mensagem);
  if (tipo === "ok") statusTimer = setTimeout(() => { status.innerHTML = ""; }, 4000);
}

function mostrarToast(mensagem, textoBotao, aoClicar) {
  const toast = document.getElementById("toast");
  toast.innerHTML = "";
  toast.append(mensagem);
  if (textoBotao) {
    const botao = document.createElement("button");
    botao.innerText = textoBotao;
    botao.addEventListener("click", () => {
      esconderToast();
      aoClicar();
    });
    toast.appendChild(botao);
  }
  toast.classList.add("visivel");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(esconderToast, 6000);
}

function esconderToast() {
  document.getElementById("toast").classList.remove("visivel");
}

// Um código único pra cada gasto (pra saber qual apagar)
function gerarId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ===== Liga tudo quando a página abre =====

// Escolheu arquivo(s) pelo botão
inputFoto.addEventListener("change", () => {
  const arquivos = [...inputFoto.files];
  inputFoto.value = ""; // permite escolher a mesma foto de novo depois
  lerArquivos(arquivos);
});

// Enter ou espaço com a área selecionada também abre o seletor
areaFoto.addEventListener("keydown", evento => {
  if (evento.key === "Enter" || evento.key === " ") {
    evento.preventDefault();
    inputFoto.click();
  }
});

// Arrastar e soltar a foto na área
["dragenter", "dragover"].forEach(nome =>
  areaFoto.addEventListener(nome, evento => {
    evento.preventDefault();
    areaFoto.classList.add("arrastando");
  })
);
["dragleave", "drop"].forEach(nome =>
  areaFoto.addEventListener(nome, evento => {
    evento.preventDefault();
    areaFoto.classList.remove("arrastando");
  })
);
areaFoto.addEventListener("drop", evento => lerArquivos([...evento.dataTransfer.files]));

// Se soltar fora da área, o navegador abriria a imagem — evitamos isso
document.addEventListener("dragover", evento => evento.preventDefault());
document.addEventListener("drop", evento => evento.preventDefault());

// Colar uma foto (Ctrl+V / Cmd+V) também funciona
document.addEventListener("paste", evento => {
  const arquivos = [...(evento.clipboardData?.files || [])].filter(a => a.type.startsWith("image/"));
  if (arquivos.length) lerArquivos(arquivos);
});

// Botão de apagar tudo
document.getElementById("limpar").addEventListener("click", () => {
  const quantos = gastos.length;
  if (confirm(`Apagar todos os ${quantos} comprovantes? Essa ação não dá pra desfazer.`)) {
    gastos = [];
    salvarGastos();
    mostrarGastos();
  }
});

// Desenha o que já estava salvo
mostrarGastos();
