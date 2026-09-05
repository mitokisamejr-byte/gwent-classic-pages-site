"use strict"

class Enum {constructor(val){this.val = val;} toString(){return this.val;}};

const DURATION_CARD_PLACEMENT = 1000;

const DUR_FADE_STEP = 10;

const CLICK_EVENT_SFX = () => AudioManager.playSFX('ui_card');

const addMouseEnterSFXBySelector = selector => {
	[...document.querySelectorAll(selector)].forEach(e =>
	e.addEventListener('mouseenter', CLICK_EVENT_SFX));
};

class Controller {}

// Makes decisions for the AI opponent player
class ControllerAI {
	constructor(player) {
		this.player = player;
	}
	
	// Collects data and weighs options before taking a weighted random action
	async startTurn(player){
		if (player.opponent().passed && (player.winning || 
				player.deck.faction === "nilfgaard" && player.total === player.opponent().total) ){
			await player.passRound();
			return;
		}
		let data_max = this.getMaximums();
		let data_board = this.getBoardData();
		let weights = player.hand.cards.map(c => 
			({weight: this.weightCard(c, data_max, data_board), action: async () => await this.playCard(c, data_max, data_board)}) );
		if (player.leaderAvailable)
			weights.push( {weight: this.weightLeader(player.leader, data_max, data_board), action: async () => await player.activateLeader()} );
		weights.push( {weight: this.weightPass(), action: async () => await player.passRound()} );
		let weightTotal = weights.reduce( (a,c) => a + c.weight, 0);
		if (weightTotal === 0){
			for (let i=0; i<player.hand.cards.length; ++i) {
				let card = player.hand.cards[i];
				if (card.row === "weather" && this.weightWeather(card) > -1 || card.abilities.includes("avenger")) {
					await weights[i].action();
					return;
				}
			}
			await player.passRound();
		} else {
			let rand = randomInt(weightTotal);
			for (var i=0; i < weights.length; ++i) {
				rand -= weights[i].weight;
				if (rand < 0)
					break;
			}
			await weights[i].action();
		}
	}
	
	// Collects data about card with the hightest power on the board
	getMaximums(){
		let rmax = board.row.map(r =>  ({row: r, cards: r.cards.filter(c => c.isUnit()).reduce( (a,c) => 
			(!a.length|| a[0].power < c.power) ? [c] : a[0].power === c.power ? a.concat([c]) : a
		, []) }) );
		
		let max = rmax.filter((r,i) => r.cards.length && i < 3).reduce((a,r) => Math.max(a, r.cards[0].power), 0);
		let max_me = rmax.filter((r,i) => i < 3 && r.cards.length && r.cards[0].power === max).reduce((a,r) => 
			a.concat(r.cards.map(c => ({row:r, card:c})))
		, []);
		
		max = rmax.filter((r,i) => r.cards.length && i > 2).reduce((a,r) => Math.max(a, r.cards[0].power), 0);
		let max_op = rmax.filter((r,i) => i > 2 && r.cards.length && r.cards[0].power === max).reduce((a,r) => 
			a.concat(r.cards.map(c => ({row:r, card:c})))
		, []);
		
		return {rmax: rmax, me: max_me, op: max_op};
	}
	
	// Collects data about the types of cards on the board and in each player's graves
	getBoardData(){
		let data = this.countCards(new CardContainer());
		Object.keys([0,1,2]).map(i => board.row[i]).forEach(r => this.countCards(r, data));
		data.grave_me = this.countCards(this.player.grave);
		data.grave_op = this.countCards(this.player.opponent().grave);
		return data;
	}
	
	// Catalogs the kinds of cards in a given CardContainer
	countCards(container, data){
		data = data ? data : {spy: [], medic: [], bond: {}, scorch: []};
		container.cards.filter(c => c.isUnit()).forEach(c => {
			for (let x of c.abilities) {
				switch (x) {
					case "spy":
					case "medic":
						data[x].push(c);
						break;
					case "scorch_r": case "scorch_c": case "scorch_s":
						data["scorch"].push(c);
						break;
					case "bond":
						if (!data.bond[c.name])
							data.bond[c.name] = 0;
						data.bond[c.name]++;
				}
			}
		});
		return data;
	}
	
	// Swaps a card from the hand with the deck if beneficial
	redraw() {
		const card = this.discardOrder({holder:this.player})[0];
		if (card && card.power < 15) {
			this.player.deck.swap(this.player.hand, card);
		}
	}
	
	// Orders discardable cards from most to least discardable
	discardOrder(card) {
		let cards = [];
		let groups = {};
		let musters = card.holder.hand.cards.filter(c => c.abilities.includes("muster"));
		while (musters.length > 0) {
			let curr = musters.pop();
			let i = curr.name.indexOf('-');
			let name = i === -1 ? curr.name : curr.name.substring(0, i).trim();
			if (!groups[name])
				groups[name] = [];
			let group = groups[name];
			group.push(curr);
			for (let j=musters.length-1; j>=0; j--)
				if (musters[j].name.startsWith(name))
					group.push( musters.splice(j,1)[0] );
		}
		
		for (let group of Object.values(groups)) {
			group.sort(Card.compare);
			group.pop();
			cards.push(...group);
		}
		
		let weathers = card.holder.hand.cards.filter(c => c.row === "weather");
		if (weathers.length > 1){
			weathers.splice(randomInt(weathers.length), 1);
			cards.push(...weathers);
		}
		
		let normal = card.holder.hand.cards.filter(c => c.abilities.length === 0);
		normal.sort(Card.compare);
		cards.push(...normal);
		return cards;
	}
	
	// Tells the Player that this object controls to play a card
	async playCard(c, max, data){
		if (c.name === "Commander's Horn")
			await this.horn(c);
		else if (c.name === "Mardroeme")
			await this.mardroeme(c);
		else if (c.name === "Decoy")
			await this.decoy(c, max, data);
		else if (c.name === "Scorch")
			await this.scorch(c, max, data);
		else
			await this.player.playCard(c);
	}
	
	// Plays a Commander's Horn to the most beneficial row. Assumes at least one viable row.
	async horn(card){
		let rows = [0,1,2].map(i => board.row[i]).filter(r => r.special === null);
		let max_row;
		let max = 0;
		for (let i=0; i<rows.length; ++i) {
			let r = rows[i];
			let dif = [0, 0];
			this.calcRowPower(r, dif, true);
			r.effects.horn++;
			this.calcRowPower(r, dif, false);
			r.effects.horn--;
			let score = dif[1] - dif[0];
			if (max < score){
				max = score;
				max_row = r;
			}
		}
		await this.player.playCardToRow(card, max_row);
	}
	
	// Plays a Mardroeme to the most beneficial row. Assumes at least one viable row.
	async mardroeme(card){ // TODO skellige
		let row, max = 0;
		for (let i=1; i<3; i++){
			let curr = this.weightMardroemeRow(card, board.row[i]);
			if (curr > max){
				max = curr;
				row = board.row[i];
			}
		}
		await this.player.playCardToRow(card, row);
	}
	
	// Selects a card to remove from a Grave. Assumes at least one valid card.
	medic(card, grave){
		let data = this.countCards(grave);
		let targ;
		if (data.spy.length){
			let min = data.spy.reduce( (a,c) => Math.min(a, c.power), Number.MAX_VALUE);
			targ = data.spy.filter(c => c.power === min)[0];
		} else if (data.medic.length) {
			let max = data.medic.reduce( (a,c) => Math.max(a, c.power), Number.MIN_VALUE);
			targ = data.medic.filter(c => c.power === max)[0];
		} else if (data.scorch.length) {
			targ = data.scorch[randomInt(data.scorch.length)];
		} else {
			let units = grave.findCards(c => c.isUnit());
			targ = units.reduce( (a,c) => a.power < c.power ? c : a, units[0] );
		}
		return targ;
	}
	
	// Selects a card to return to the Hand and replaces it with a Decoy. Assumes at least one valid card.
	async decoy(card, max, data) {
		let targ, row;
		if (data.spy.length){
			let min = data.spy.reduce( (a,c) => Math.min(a, c.power), Number.MAX_VALUE);
			targ = data.spy.filter(c => c.power === min)[0];
		} else if (data.medic.length) {
			targ = data.medic[randomInt(data.medic.length)];
		} else if (data.scorch.length) {
			targ = data.scorch[randomInt(data.scorch.length)];
		} else {
			let pairs = max.rmax.filter((r,i) => i<3 && r.cards.length).reduce((a,r) => 
				r.cards.map(c => ({r:r.row, c:c})).concat(a)
			, []);
			let pair = pairs[randomInt(pairs.length)];
			targ = pair.c;
			row = pair.r;
		}
		
		for (let i = 0; !row ; ++i){
			if (board.row[i].cards.indexOf(targ) !== -1){
				row = board.row[i];
				break;
			}
		}
		
		setTimeout(() => board.toHand(targ, row), 1000);
		await this.player.playCardToRow(card, row);
	}
	
	// Tells the controlled Player to play the Scorch card
	async scorch(card, max, data){
		await this.player.playScorch(card);
	}

	// Gets the row that would be best for the passed agile card
	determineAgileRow(card)
	{
		const close = board.getRow(card, "close", card.holder);
		const ranged = board.getRow(card, "ranged", card.holder);
		const vClose = close.getVirtualCopy();
		const vRanged = ranged.getVirtualCopy();
		vClose.cards.push(card);
		vClose.updateState(card, true);
		vRanged.cards.push(card);
		vRanged.updateState(card, true);
		const dif = (vClose.calcScore() - close.calcScore()) - (vRanged.calcScore() - ranged.calcScore());
		return dif > 0 ? close : dif < 0 ? ranged : Math.random() >0.5 ? close : ranged; 
	}

	// Assigns a weight for how likely the conroller is to Pass the round
	weightPass(){
		if (this.player.health === 1)
			return 0;
		let dif = this.player.opponent().total - this.player.total;
		if (dif > 30)
			return 100;
		if (dif < -30 && this.player.opponent().handsize - this.player.handsize > 2)
			return 100;
		return Math.floor(Math.abs(dif));
	}
	
	// Assigns a weight for how likely the controller is to activate its leader ability
	weightLeader(card, max, data) {
		let w = ability_dict[card.abilities[0]].weight;
		if (ability_dict[card.abilities[0]].weight) {
			let score = w(card, this, max, data);
			return score;
		}
		return 10 + (game.roundCount-1) * 15;
	}
	
	// Assigns a weight for how likely the controller will use a scorch-row card
	weightScorchRow(card, max, row_name) {
		let index = 3 + (row_name==="close" ? 0 : row_name==="ranged" ? 1 : 2);
		if (board.row[index].total < 10)
			return 0;
		let score = max.rmax[index].cards.reduce((a,c) => a + c.power, 0);
		return score;
	}
	
	// Calculates a weight for how likely the conroller will use horn on this row
	weightHornRow(card, row){
		return row.special !== null ? 0 : this.weightRowChange(card, row);
	}
	
	// Calculates weight for playing a card on a given row, min 0
	weightRowChange(card, row){
		return Math.max(0, this.weightRowChangeTrue(card, row));
	}
	
	// Calculates weight for playing a card on the given row
	weightRowChangeTrue(card, row) {
		let dif = [0,0];
		this.calcRowPower(row, dif, true);
		row.updateState(card, true);
		this.calcRowPower(row, dif, false);
		if (!card.isSpecial())
			dif[0] -= row.calcCardScore(card);
		row.updateState(card, false);
		return dif[1] - dif[0];
	}
	
	// Calculates the weight for playing a weather card
	weightWeather(card) {
		let rows;
		if (card.name === "Clear Weather")
			rows = Object.values(weather.types).filter(t => t.count > 0).flatMap(t => t.rows);
		else
			rows = Object.values(weather.types).filter(t => t.count === 0 && t.name === card.abilities[0]).flatMap(t => t.rows);
		if (!rows.length)
			return 1;
		let dif = [0,0];
		rows.forEach( r => {
			let state = r.effects.weather;
			this.calcRowPower(r, dif, true);
			r.effects.weather = !state;
			this.calcRowPower(r, dif, false);
			r.effects.weather = state;
		});
		return dif[1] - dif[0];
	}
	
	// Calculates the weight for playing a mardroeme card
	weightMardroemeRow(card, row){
		if (card.name === "Mardroeme" && row.special !== null)
			return 0;
		let ermion = card.holder.hand.cards.filter(c => c.name === "Ermion").length > 0;
		if (ermion && card.name !== "Ermion" && row === board.row[1])
			return 0;
		let name = row === board.row[1] ? "Young Berserker" : "Berserker";
		let n = row.cards.filter(c => c.name === name).length;
		let weight = row === board.row[2] ? 10*n : 8*n*n - 2*n
		return Math.max(1, weight);
	}
	
	// Calculates the weight for cards with the medic ability
	weightMedic(data, score, owner){
		let units = owner.grave.findCards(c => c.isUnit());
		let grave = data["grave_" + owner.opponent().tag];
		return !units.length ? Math.min(1,score) : score + (grave.spy.length ? 50 : grave.medic.length ? 15 : grave.scorch.length  ? 10 : this.player.health === 1 ? 1 : 0);
	}
	
	// Calculates the weight for cards with the berserker ability
	weightBerserker(card, row, score){
		if (card.holder.hand.cards.filter(c => c.abilities.includes("mardroeme")).length < 1 && !row.effects.mardroeme > 0)
			return score;
		score -= card.basePower;
		if (card.row === "close")
			score += 14;
		else {
			let n = 0;
			if (!row.effects.mardroeme)
				n = row.cards.filter(c => c.name === "Young Berserker").length;
			else
				n = row.cards.filter(c => "Transformed Young Vildkaarl").length;
			score = 8*((n+1)*(n+1) - n*n) + n*score;
		}
		return Math.max(1, score);
	}
	
	// Calculates the weight for a weather card if played from the deck
	weightWeatherFromDeck(card, weather_id) {
		if (card.holder.deck.findCard(c => c.abilities.includes(weather_id)) === undefined)
			return 0;
		return this.weightCard({abilities:[weather_id], row:"weather"});
	}
	
	// Assigns a weights for how likely the controller with play a card from its hand
	weightCard(card, max, data){
		if (card.name === "Decoy")
			return data.spy.length ? 50 : data.medic.length ? 15 : data.scorch.length  ? 10 : max.me.length ? 1 : 0;
		if (card.name === "Commander's Horn") {
			let rows = [0,1,2].map(i => board.row[i]).filter(r => r.special === null);
			if (!rows.length)
				return 0;
			rows = rows.map(r => this.weightHornRow(card, r) );
			return Math.max(...rows)/2;
		}
		
		if (card.abilities) {
			if (card.abilities.includes("scorch")) {
				let power_op = max.op.length ? max.op[0].card.power : 0;
				let power_me = max.me.length ? max.me[0].card.power : 0;
				let total_op = power_op * max.op.length;
				let total_me = power_me * max.me.length;
				return power_me > power_op ? 0 : power_me < power_op ? total_op : Math.max(0, total_op - total_me);
			}
			if (card.abilities.includes("decoy")) {
				return data.spy.length ? 50 : data.medic.length ? 15 : data.scorch.length  ? 10 : max.me.length ? 1 : 0;
			}
			if (card.abilities.includes("mardroeme")) {
				let rows = [1,2].map(i => board.row[i]);
				return Math.max(...rows.map(r => this.weightMardroemeRow(card, r)) );
			}
		}
		
		if (card.row === "weather") {
			return Math.max(0, this.weightWeather(card));
		}
		
		let row;
		if (card.row === 'agile')
			row = this.determineAgileRow(card);
		else
			row = board.getRow(card, card.row === "agile" ? "close" : card.row, this.player);
		let score = row.calcCardScore(card);
		switch(card.abilities[card.abilities.length -1])
		{
			case "bond": 
			case "morale":
			case "horn":
				score = this.weightRowChange(card, row); break;
			case "medic": 
				score = this.weightMedic(data, score, card.holder);	break;
			case "spy": score = 15 + score; break;
			case "muster": score *= 3; break;
			case "scorch_c":
				score = Math.max(1, this.weightScorchRow(card, max, "close")); break;
			case "scorch_r": 
				score = Math.max(1, this.weightScorchRow(card, max, "ranged")); break;
			case "scorch_s":
				score = Math.max(1, this.weightScorchRow(card, max, "siege")); break;
			case "berserker":
				score = this.weightBerserker(card, row, score); break;
			case "avenger": case "avenger_kambi":
				return score + ability_dict[card.abilities[card.abilities.length -1]].weight();
		}
		
		return score;
	}
	
	// Calculates the current power of a row associated with each Player
	calcRowPower(r, dif, add){
		r.findCards(c => c.isUnit()).forEach(c => {
			let p = r.calcCardScore(c); 
			c.holder === this.player ? (dif[0]+= add ? p : -p) : (dif[1]+= add ? p : -p);
		});
	}
}

// Can make actions during turns like playing cards that it owns
class Player {
	constructor(id, name, deck, remote = false) {
		this.id = id;
		this.tag = (id === 0) ? "me" : "op";
		this.controller = (id === 0) ? new Controller() : remote ? new ControllerRemote(this) : new ControllerAI(this);

		this.hand = (id === 0) ? new Hand(document.getElementById("hand-row")) : remote ? new HandRemote() : new HandAI();
		this.grave =  new Grave( document.getElementById("grave-" + this.tag));
		this.deck = new Deck(deck.faction, document.getElementById("deck-" + this.tag));
		this.deck.rngRole = mp.roleOfId(id);
		this.deck_data = deck;
		
		this.leader = new Card(deck.leader, this);
		this.elem_leader = document.getElementById("leader-" + this.tag);
		this.elem_leader.children[0].appendChild( this.leader.elem );

		this.reset();
		
		this.name = name;
		document.getElementById("name-" + this.tag).innerHTML = name;

		document.getElementById("deck-name-" +this.tag).innerHTML = I18N.faction(deck.faction, "name", factions[deck.faction].name);
		document.getElementById("stats-" + this.tag).getElementsByClassName("profile-img")[0].children[0].children[0];
		let x = document.querySelector("#stats-" +this.tag+ " .profile-img > div > div");
		x.style.backgroundImage = iconURL("deck_shield_" + deck.faction);
	}
	
	// Sets default values
	reset(){
		this.grave.reset();
		this.hand.reset();
		this.deck.reset();
		this.deck.initializeFromID(this.deck_data.cards, this);
		
		this.health = 2;
		this.total = 0;
		this.passed = false;
		this.handsize = 10;
		this.winning = false;
	
		this.enableLeader();
		this.setPassed(false);
		document.getElementById("gem1-" +this.tag).classList.add("gem-on");
		document.getElementById("gem2-" +this.tag).classList.add("gem-on");
	}
	
	// Returns the opponent Player
	opponent(){
		return board.opponent(this);
	}
	
	// Updates the player's total score and notifies the gamee
	updateTotal(n){
		this.total += n;
		document.getElementById("score-total-" + this.tag).children[0].innerHTML = this.total;
		board.updateLeader();
	}
	
	// Puts the player in the winning state
	setWinning(isWinning) {
		if (this.winning ^ isWinning)
			document.getElementById("score-total-" + this.tag).classList.toggle("score-leader");
		this.winning = isWinning;
	}
	
	// Puts the player in the passed state
	setPassed(hasPassed) {
		if (this.passed ^ hasPassed)
			document.getElementById("passed-" + this.tag).classList.toggle("passed");
		this.passed = hasPassed;
	}
	
	// Sets up board for turn
	async startTurn(){
		document.getElementById("stats-" + this.tag).classList.add("current-turn");
		if (this.leaderAvailable)
			this.elem_leader.children[1].classList.remove("hide");
		
		if (this === player_me) {
			document.getElementById("pass-button").classList.remove("noclick");
		}
		
		if (typeof this.controller.startTurn === "function") {
			await this.controller.startTurn(this);
		}
	}
	
	// Passes the round and ends the turn
	passRound(){
		this.setPassed(true);
		EventManager.roundPassed.dispatch(this, game.roundCount);
		this.endTurn();
	}
	
	// Plays a scorch card
	async playScorch(card){
		await this.playCardAction(card, async () => await ability_dict["scorch"].activated(card));
	}
	
	// Plays a card to a specific row
	async playCardToRow(card, row){
		await this.playCardAction(card, async () => await board.moveTo(card, row, this.hand));
	}
	
	// Plays a card to the board
	async playCard(card){
		await this.playCardAction(card, async () => await card.autoplay(this.hand));
	}
	
	// Shows a preview of the card being played, plays it to the board and ends the turn
	async playCardAction(card, action){
		ui.showPreviewVisuals(card);
		await sleep(1000);
		ui.hidePreview(card);
		await action();
		this.endTurn();
	}
	
	// Handles end of turn visuals and behavior the notifies the game
	endTurn(){
		if (!this.passed && !this.canPlay())
			this.setPassed(true);
		if (this === player_me){
			document.getElementById("pass-button").classList.add("noclick");
		}
		document.getElementById("stats-" + this.tag).classList.remove("current-turn");
		this.elem_leader.children[1].classList.add("hide");
		game.endTurn()
	}
	
	// Tells the the Player if it won the round. May damage health.
	endRound(win){
		if (!win) {
			if (this.health < 1)
				return;
			document.getElementById("gem" + this.health + "-" +this.tag).classList.remove("gem-on");
			this.health--;
		}
		this.setPassed(false);
		this.setWinning(false);
	}
	
	// Returns true if the Player can make any action other than passing
	canPlay() {
		return this.hand.cards.le
